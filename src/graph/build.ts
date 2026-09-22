import type { Store } from '../store/db.js';
import type { LoreConfig } from '../config.js';
import { STOPWORDS, normalizeKey } from '../normalize.js';
import { isAcronymToken } from '../entities/extract.js';

/**
 * In-memory undirected graph over blocks ∪ entities, CSR layout.
 * Node indices: [0, blockCount) are blocks, [blockCount, n) are entities.
 */
export interface LoreGraph {
  n: number;
  blockCount: number;
  entityCount: number;
  /** node idx → db id (block id or entity id depending on range). */
  nodeDbId: Int32Array;
  blockIndex: Map<number, number>;
  entityIndex: Map<number, number>;
  entityKeyIndex: Map<string, number>;
  /** entity node idx → key (for explanations). */
  entityKeys: string[];
  /**
   * Per-entity inverse document frequency, 0..1, indexed like `entityKeys`.
   *
   * An entity mentioned in a quarter of the vault is not a topic, it is
   * background. Spreading activation from it reaches a quarter of the vault,
   * which is the same as reaching nothing. Measured on a real docs vault, the
   * query "when should I use a worktree" seeded `use` with exactly the mass of
   * `worktree`, and `im` — the tokenizer's reading of "I'm" — was an entity in
   * 9 of 39 notes, as widespread as `subagent`.
   *
   * This is the general form of a stopword list, and unlike one it needs no
   * maintenance, works in any language, and adapts to the vault: a term is
   * uninformative HERE if it is everywhere HERE.
   */
  entityIdf: Float64Array;
  /**
   * Explicit structure per note: (links + tagged notes + facts) / notes.
   *
   * The graph channel is a RECALL mechanism that adds notes nothing else
   * found. That is worth real precision when the vault has a graph — measured
   * +13 to +25 points of reach on the link-rich corpora — and it is pure
   * noise when the vault has none, because all that remains is entity
   * co-occurrence over prose. Measured on BEIR SciFact (5 183 abstracts, zero
   * links, zero tags, zero facts): the graph channel cost 0.024 nDCG@10,
   * taking 0.676 to 0.653. A vault with no structure has not earned the walk.
   *
   * Facts count, and the test suite is why: a two-note vault whose only
   * relation is an ASSERTED fact has no links and no tags, and a
   * links-and-tags-only measure locked its own fact edges out of the walk. A
   * stated relation is the most explicit structure a vault can carry.
   */
  structureRatio: number;
  offsets: Int32Array;
  neighbors: Int32Array;
  weights: Float64Array;
  /** Per-edge weight allowed to propagate past hop 1 (relational evidence
   *  only — co-occurrence and similarity are texture and stop at depth). */
  weightsDeep: Float64Array;
}

/**
 * Build the graph from the store. Edge sources:
 *  MENTION  block ↔ entity        (0.7 × confidence; note-level mentions ×0.5 to every block)
 *  LINK     block ↔ entity(target)(1.0)
 *  COOCCUR  entity ↔ entity       (0.4, same-block co-occurrence, capped per block)
 *  SIMILAR  block ↔ block         (0.8 × cosine, from persisted edges table)
 */
/**
 * Options nothing in the product passes.
 *
 * `nodeLimit` exists so the ceiling below is reachable from a test: the real
 * reproduction is an 8.4 MB file of heading lines and takes 92 s to index,
 * which is not a thing to put in a suite. It defaults to the packing limit and
 * is not a tuning knob — raising it past 2^21 silently corrupts edge keys.
 */
export interface BuildGraphOptions {
  nodeLimit?: number;
}

export function buildGraph(
  store: Store,
  config: LoreConfig,
  opts: BuildGraphOptions = {},
): LoreGraph {
  const db = store.db;
  const ew = config.graph.edgeWeights;

  // Ordered by CONTENT, not by rowid. Node indices decide how ties break in
  // every downstream sort (graphRanks, the backfill tier), and rowids trace
  // back to insertion order — so a fresh index and an incremental one built
  // the same graph with the nodes numbered differently, and a byte-identical
  // vault returned two different result orders. Path+anchor is the same
  // content-derived key the result sorts already use.
  const blocks = db
    .prepare(`SELECT id, note_path, anchor FROM blocks WHERE archived=0 ORDER BY note_path, anchor`)
    .all() as { id: number; note_path: string; anchor: string }[];
  const entities = db.prepare(`SELECT id, key, display FROM entities ORDER BY key`).all() as {
    id: number;
    key: string;
    display: string;
  }[];
  const noteTotal =
    (db.prepare(`SELECT COUNT(*) c FROM notes`).get() as { c: number }).c || 1;
  const linkTotal = (db.prepare(`SELECT COUNT(*) c FROM links`).get() as { c: number }).c;
  const taggedTotal = (
    db.prepare(`SELECT COUNT(*) c FROM notes WHERE tags != '[]'`).get() as { c: number }
  ).c;
  const factTotal = (db.prepare(`SELECT COUNT(*) c FROM facts`).get() as { c: number }).c;
  const structureRatio = (linkTotal + taggedTotal + factTotal) / noteTotal;
  const entityDf = new Map<number, number>();
  for (const r of db
    .prepare(`SELECT entity_id, COUNT(DISTINCT note_path) n FROM mentions GROUP BY entity_id`)
    .all() as { entity_id: number; n: number }[]) {
    entityDf.set(r.entity_id, r.n);
  }

  const blockCount = blocks.length;
  const entityCount = entities.length;
  const n = blockCount + entityCount;
  const nodeDbId = new Int32Array(n);
  const blockIndex = new Map<number, number>();
  const entityIndex = new Map<number, number>();
  const entityKeyIndex = new Map<string, number>();
  const entityKeys: string[] = new Array(entityCount);
  const entityIdf = new Float64Array(entityCount);
  const blocksByNote = new Map<string, number[]>();

  blocks.forEach((b, i) => {
    nodeDbId[i] = b.id;
    blockIndex.set(b.id, i);
    const arr = blocksByNote.get(b.note_path);
    if (arr) arr.push(i);
    else blocksByNote.set(b.note_path, [i]);
  });
  entities.forEach((e, i) => {
    const idx = blockCount + i;
    nodeDbId[idx] = e.id;
    entityIndex.set(e.id, idx);
    entityKeyIndex.set(e.key, idx);
    entityKeys[i] = e.key;
    const df = entityDf.get(e.id) ?? 1;
    entityIdf[i] = Math.log((noteTotal + 1) / (df + 1)) / Math.log(noteTotal + 1);
  });

  // Accumulate edges in a Map keyed by packed (min,max) pair; sum weights.
  // Each edge carries TWO weights: the full one, and its "deep" share — what
  // may keep propagating past the first hop. Relational evidence (links,
  // facts, identity, mentions) travels; co-occurrence and embedding
  // similarity do not: they are neighborhood texture, and compounding them
  // across hops is how a walk drowns a two-hop answer under a one-hop wall.
  const acc = new Map<number, { w: number; deep: number }>();
  const BITS = 21; // supports ~2M nodes
  const nodeLimit = opts.nodeLimit ?? 1 << BITS;
  if (n >= nodeLimit) {
    // `graph too large: 2100001 nodes` was the whole message. It fires on the
    // RETRIEVAL path, not at index time — `lore index` reports success and then
    // every search in the vault fails — so the user saw a raw internal number
    // about a healthy-looking index, naming no file and offering no way out.
    // A block is one heading-with-no-body, so four bytes of markdown buy a
    // node and a single machine-generated note can take a whole vault over.
    // blocksByNote is already built above, so naming the culprit costs nothing.
    let worst = '';
    let worstCount = 0;
    for (const [path, idxs] of blocksByNote) {
      if (idxs.length > worstCount) {
        worst = path;
        worstCount = idxs.length;
      }
    }
    const share = Math.round((worstCount / n) * 100);
    throw new Error(
      `graph too large: ${n} nodes (${blockCount} blocks + ${entities.length} ` +
        `${entities.length === 1 ? 'entity' : 'entities'}), ` +
        `over the limit of ${nodeLimit}` +
        (worst
          ? ` — the largest contributor is ${worst} with ${worstCount} blocks (${share}%). ` +
            `Add it to "ignore" in .lore/config.json and re-index, or split it into smaller notes.`
          : '.'),
    );
  }
  const addEdge = (a: number, b: number, w: number, deepShare = 1) => {
    if (a === b || w <= 0) return;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * (1 << BITS) + hi;
    const cur = acc.get(key);
    if (cur) {
      cur.w += w;
      cur.deep += w * deepShare;
    } else {
      acc.set(key, { w, deep: w * deepShare });
    }
  };

  // MENTION edges (+ collect per-block entity sets for COOCCUR)
  const mentions = db
    .prepare(
      `SELECT m.entity_id, m.note_path, m.block_anchor, m.confidence, b.id AS block_id
       FROM mentions m
       LEFT JOIN blocks b ON b.note_path = m.note_path AND b.anchor = m.block_anchor`,
    )
    .all() as {
    entity_id: number;
    note_path: string;
    block_anchor: string;
    confidence: number;
    block_id: number | null;
  }[];

  const perBlockEntities = new Map<number, { idx: number; conf: number }[]>();
  for (const m of mentions) {
    const eIdx = entityIndex.get(m.entity_id);
    if (eIdx === undefined) continue;
    if (m.block_id !== null) {
      const bIdx = blockIndex.get(m.block_id);
      if (bIdx === undefined) continue;
      addEdge(bIdx, eIdx, ew.MENTION * m.confidence);
      const list = perBlockEntities.get(bIdx);
      if (list) list.push({ idx: eIdx, conf: m.confidence });
      else perBlockEntities.set(bIdx, [{ idx: eIdx, conf: m.confidence }]);
    } else {
      // note-level mention (tag/title/frontmatter): weak edge to each block
      for (const bIdx of blocksByNote.get(m.note_path) ?? []) {
        addEdge(bIdx, eIdx, ew.MENTION * m.confidence * 0.5);
      }
    }
  }

  // LINK edges: block → entity named by the link target
  const links = db
    .prepare(`SELECT note_path, block_anchor, target_norm FROM links`)
    .all() as { note_path: string; block_anchor: string; target_norm: string }[];
  const blockByNoteAnchor = db
    .prepare(`SELECT id, note_path, anchor FROM blocks`)
    .all() as { id: number; note_path: string; anchor: string }[];
  const anchorMap = new Map<string, number>();
  for (const b of blockByNoteAnchor) anchorMap.set(`${b.note_path} ${b.anchor}`, b.id);
  for (const l of links) {
    const eIdx = entityKeyIndex.get(l.target_norm);
    if (eIdx === undefined) continue; // broken link
    const bId = anchorMap.get(`${l.note_path} ${l.block_anchor}`);
    if (bId === undefined) continue;
    const bIdx = blockIndex.get(bId);
    if (bIdx === undefined) continue;
    addEdge(bIdx, eIdx, ew.LINK);
  }

  // SAMEAS edges: one thing under several names is the ordinary state of a
  // vault — "Bob", "Robert Smith", and "[[rsmith]]" arrive as three entity
  // nodes, and spreading activation from one reaches none of the content
  // filed under the others (HippoRAG's ablation prices exactly this class of
  // edge at 3.5 R@5 points, on a corpus with BETTER name hygiene than any
  // vault). Two deterministic layers, both identity claims rather than
  // co-occurrence evidence, hence the high weight:
  //
  //  1. Declared: the note's own frontmatter `aliases:` list (the Obsidian
  //     convention), connecting the title's entity to each alias's entity.
  //  2. Acronym: a multi-word entity whose initials spell another entity key
  //     ("motherson technology services" ↔ "mts"). Initials shorter than 3
  //     letters are ignored — two-letter collisions are noise, not identity.
  const noteMeta = db
    .prepare(`SELECT title, frontmatter FROM notes`)
    .all() as { title: string; frontmatter: string }[];
  for (const nm of noteMeta) {
    let fm: Record<string, unknown>;
    try {
      fm = JSON.parse(nm.frontmatter) as Record<string, unknown>;
    } catch {
      continue;
    }
    const raw = fm.aliases ?? fm.alias;
    if (!raw) continue;
    const aliases = (Array.isArray(raw) ? raw : [raw]).filter(
      (a): a is string => typeof a === 'string',
    );
    const titleIdx = entityKeyIndex.get(normalizeKey(nm.title));
    if (titleIdx === undefined) continue;
    for (const alias of aliases) {
      const aliasIdx = entityKeyIndex.get(normalizeKey(alias));
      if (aliasIdx !== undefined) addEdge(titleIdx, aliasIdx, ew.SAMEAS);
    }
  }
  // Two guards, because an identity edge is the most damaging thing to get
  // wrong (weight 0.9 and deep-propagating — a false merge is indistinguishable
  // from a stated fact). Initials skip stopwords, so "The Old Mill" yields "om"
  // rather than "tom"; and the target must actually LOOK like an acronym in
  // the vault, so a person named Tom is never merged into a mill. Measured
  // before the guards: "The Old Mill" ≡ "Tom" at full weight, and PPR seeded
  // from `tom` ranked the mill's note above Tom's own page.
  const acronymEntity = new Set<string>();
  for (const e of entities) if (isAcronymToken(e.display)) acronymEntity.add(e.key);
  for (const [key, idx] of entityKeyIndex) {
    const words = key.split(' ').filter((w) => w && !STOPWORDS.has(w));
    if (words.length < 2) continue;
    const initials = words.map((w) => w[0] ?? '').join('');
    if (initials.length < 3) continue;
    if (!acronymEntity.has(initials)) continue;
    const acronymIdx = entityKeyIndex.get(initials);
    if (acronymIdx !== undefined) addEdge(idx, acronymIdx, ew.SAMEAS);
  }

  // FACT edges: subject ↔ object of currently-valid facts.
  //
  // The fact store knew "Hollowmere :: funder :: Quillon Endowment" and the
  // graph did not — PPR walked mention and co-occurrence edges while the
  // strongest relational evidence in the vault sat outside it. A two-hop
  // question ("Ironbark Archive benefactor") is four steps in the bipartite
  // block↔entity graph, beyond a shallow walk; as entity↔entity fact edges
  // the same chain is two steps. Only currently-valid facts contribute: a
  // superseded relation is history, and the graph ranks the present.
  const factRows = db
    .prepare(
      `SELECT subject, object FROM facts
       WHERE valid_until IS NULL AND superseded_by IS NULL`,
    )
    .all() as { subject: string; object: string }[];
  for (const f of factRows) {
    const sIdx = entityKeyIndex.get(normalizeKey(f.subject));
    const oIdx = entityKeyIndex.get(normalizeKey(f.object));
    if (sIdx !== undefined && oIdx !== undefined) addEdge(sIdx, oIdx, ew.FACT);
  }

  // COOCCUR edges among entities of a block (capped).
  //
  // Weight is divided by the block's entity count: two entities named in a
  // sentence together is real evidence, whereas two names in a 20-item list
  // is almost none. Without this, list/index blocks dominate the graph —
  // measured, a genuine relational edge carried 2.8% of a node's out-strength
  // while list-block co-occurrence siblings took 4-5x more.
  const cap = config.graph.maxEntitiesPerBlockCooccur;
  for (const list of perBlockEntities.values()) {
    if (list.length < 2) continue;
    const top = list.sort((a, b) => b.conf - a.conf).slice(0, cap);
    const dilution = 1 / Math.log2(2 + top.length);
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        addEdge(
          top[i]!.idx,
          top[j]!.idx,
          ew.COOCCUR * Math.min(top[i]!.conf, top[j]!.conf) * dilution,
          0, // texture, not a claim — does not propagate past hop 1
        );
      }
    }
  }

  // SIMILAR edges from persisted table (block ids)
  const sims = db
    .prepare(`SELECT src_id, dst_id, weight FROM edges WHERE type='SIMILAR'`)
    .all() as { src_id: number; dst_id: number; weight: number }[];
  for (const s of sims) {
    const a = blockIndex.get(s.src_id);
    const b = blockIndex.get(s.dst_id);
    if (a === undefined || b === undefined) continue;
    // Texture, like co-occurrence: full weight at hop 1, nothing at depth.
    //
    // 0.29.0 gave this a half share at depth, reasoning that an embedding
    // similarity edge is a claim about CONTENT and that a SIMILAR-only block
    // otherwise scores exactly 0 in the final vector. Both halves of that
    // reasoning are true, and the conclusion was still wrong: the eval could
    // not run embeddings at the time, so nothing measured it. Now that it
    // can, deep=0 beats deep=0.5 on all three corpora (kestrel MRR 0.539 vs
    // 0.533, northwind 0.604 vs 0.570). Similarity is a statement about two
    // blocks, not a chain of claims, and compounding it across hops costs
    // more precision than the reach it buys.
    addEdge(a, b, ew.SIMILAR * s.weight, 0);
  }

  // Build CSR (undirected: each edge in both adjacency lists)
  const degree = new Int32Array(n);
  for (const key of acc.keys()) {
    const lo = Math.floor(key / (1 << BITS));
    const hi = key % (1 << BITS);
    degree[lo]!++;
    degree[hi]!++;
  }
  const offsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i]! + degree[i]!;
  const m2 = offsets[n]!;
  const neighbors = new Int32Array(m2);
  const weights = new Float64Array(m2);
  const weightsDeep = new Float64Array(m2);
  const cursor = Int32Array.from(offsets.subarray(0, n));
  for (const [key, e] of acc.entries()) {
    const lo = Math.floor(key / (1 << BITS));
    const hi = key % (1 << BITS);
    neighbors[cursor[lo]!] = hi;
    weights[cursor[lo]!] = e.w;
    weightsDeep[cursor[lo]!] = e.deep;
    cursor[lo]!++;
    neighbors[cursor[hi]!] = lo;
    weights[cursor[hi]!] = e.w;
    weightsDeep[cursor[hi]!] = e.deep;
    cursor[hi]!++;
  }

  return {
    n,
    blockCount,
    entityCount,
    nodeDbId,
    blockIndex,
    entityIndex,
    entityKeyIndex,
    entityKeys,
    entityIdf,
    structureRatio,
    offsets,
    neighbors,
    weights,
    weightsDeep,
  };
}
