import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { isHeadingEcho } from '../vault/parse.js';
import type { LoreContext } from '../context.js';
import { normalizeKey } from '../normalize.js';
import { buildNameIndex, buildNameResolver, resolveNoteName } from '../retrieve/expand.js';
import { safeVaultPath } from '../capture.js';
import { daysBetween, retrievability } from '../dynamics/fsrs.js';
import { fitDecay, storeDecay, vaultDecay, type DecayFit } from '../dynamics/fit.js';

/**
 * Idle-time consolidation ("dreaming"): the engine reviews its own state and
 * emits a report of duplicates, contradictions, stale knowledge, missing
 * links, and orphans. Passes are deterministic; nothing here rewrites user
 * prose (the ACE anti-collapse rule). `apply` writes ONLY new files under
 * the lore/ namespace: a digest and a review-queue note.
 */

export interface DuplicateFinding {
  a: { notePath: string; anchor: string };
  b: { notePath: string; anchor: string };
  jaccard: number;
}

export interface ContradictionFinding {
  subject: string;
  predicate: string;
  objects: string[];
  kind: 'contested' | 'recent-supersession';
  detail: string;
}

export interface StaleFinding {
  kind: 'block' | 'fact';
  ref: string;
  importance?: number;
  retrievability?: number;
  detail: string;
}

export interface LinkSuggestion {
  from: string;
  to: string;
  /** The strongest few shared entities (display only). */
  sharedEntities: string[];
  /** How many distinct entities actually back this pair (ranking uses this). */
  sharedCount: number;
  /**
   * IDF-weighted shared evidence, normalized by note size. Rare co-mentions
   * score higher; long notes do not score higher merely for being long.
   */
  score: number;
}

export interface DreamReport {
  generatedAt: string;
  stats: {
    notes: number;
    blocks: number;
    entities: number;
    facts: number;
    openFacts: number;
    accessEvents: number;
  };
  duplicates: DuplicateFinding[];
  contradictions: ContradictionFinding[];
  stale: StaleFinding[];
  linkSuggestions: LinkSuggestion[];
  orphans: string[];
  written: string[];
  /** Present when this pass fitted the vault's forgetting-curve shape. */
  decayFit?: DecayFit;
  /**
   * True totals before display truncation, so the CLI never presents a
   * `.slice(0, 50)` length as if it were the real count.
   */
  totals: {
    duplicates: number;
    contradictions: number;
    stale: number;
    linkSuggestions: number;
    orphans: number;
  };
  /**
   * Detectors that cannot fire because their inputs do not exist yet (e.g.
   * no facts asserted). Reported as "n/a", not as a clean bill of health.
   */
  inactive: string[];
}

/**
 * A duplicate is a pair, not an ordered one — "n0 duplicates n1" and "n1
 * duplicates n0" are the same finding. Which side came first followed row
 * order, so the same vault reported the same pairs written the other way
 * round, and sorting them afterwards produced a different sequence.
 */
function orientedPair(
  x: { notePath: string; anchor: string },
  y: { notePath: string; anchor: string },
  jaccard: number,
): DuplicateFinding {
  const swap = cmp(x.notePath, y.notePath) > 0 || (x.notePath === y.notePath && cmp(x.anchor, y.anchor) > 0);
  return swap ? { a: y, b: x, jaccard } : { a: x, b: y, jaccard };
}

/** Lexicographic compare, for making tied findings deterministic. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const SHINGLE = 8;
/**
 * Real prose rarely exceeds ~0.3 Jaccard even when two passages plainly say
 * the same thing, so the original 0.85 gate reported nothing on real vaults.
 * Findings are ranked by similarity, so a lower gate surfaces candidates
 * instead of flooding the report.
 */
const JACCARD_THRESHOLD = 0.45;

/**
 * MinHash signature over 8-token shingles.
 *
 * The previous implementation held every distinct shingle as a string in a
 * Set: on a 20k-note vault that is ~19.6M entries, which exceeds V8's Map/Set
 * capacity and threw RangeError before it could even OOM. A fixed-width
 * signature makes memory O(notes x K) regardless of note length, and Jaccard
 * is estimated by counting equal positions.
 */
const SIG_LEN = 64;

function hashToken(str: string, seed: number): number {
  // FNV-1a, seeded — cheap and well distributed enough for MinHash.
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function signature(text: string): Int32Array | null {
  const tokens = normalizeKey(text).split(' ').filter(Boolean);
  if (tokens.length < SHINGLE) return null;
  const sig = new Int32Array(SIG_LEN).fill(0x7fffffff);
  for (let i = 0; i + SHINGLE <= tokens.length; i++) {
    const gram = tokens.slice(i, i + SHINGLE).join(' ');
    for (let k = 0; k < SIG_LEN; k++) {
      const h = hashToken(gram, k) & 0x7fffffff;
      if (h < sig[k]!) sig[k] = h;
    }
  }
  return sig;
}

/** Estimated Jaccard: fraction of signature positions that agree. */
function sigSimilarity(a: Int32Array, b: Int32Array): number {
  let same = 0;
  for (let i = 0; i < SIG_LEN; i++) if (a[i] === b[i]) same++;
  return same / SIG_LEN;
}

function findDuplicates(ctx: LoreContext): DuplicateFinding[] {
  const all = ctx.store.db
    .prepare(`SELECT id, note_path, anchor, heading, text, hash FROM blocks WHERE archived=0`)
    .all() as {
    id: number;
    note_path: string;
    anchor: string;
    heading: string;
    text: string;
    hash: string;
  }[];
  // Heading echoes are not authored content — see isHeadingEcho. Comparing
  // them reported "The Process" ≈ "The Process" at Jaccard 1.0 for two
  // unrelated skills; 40 of 501 blocks in a real docs vault are echoes and
  // they produced most of the duplicate findings.
  // Sorted, because everything below depends on the order: an exact-duplicate
  // group emits its pairs against whichever member comes first, and the LSH
  // banding walks candidates in this order too. Unsorted that is row order,
  // which follows edit history, so the same vault reported a different SET of
  // pairs depending on how the index was built.
  const rows = all
    .filter((r) => !isHeadingEcho(r.heading, r.text))
    .sort((x, y) => cmp(x.note_path, y.note_path) || cmp(x.anchor, y.anchor));
  const out: DuplicateFinding[] = [];
  const emitted = new Set<string>();
  const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  // exact duplicates by content hash (cross-note only)
  const byHash = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byHash.get(r.hash);
    if (arr) arr.push(r);
    else byHash.set(r.hash, [r]);
  }
  for (const group of byHash.values()) {
    for (let i = 1; i < group.length; i++) {
      if (group[0]!.note_path === group[i]!.note_path) continue;
      out.push(
        orientedPair(
          { notePath: group[0]!.note_path, anchor: group[0]!.anchor },
          { notePath: group[i]!.note_path, anchor: group[i]!.anchor },
          1,
        ),
      );
      emitted.add(pairKey(group[0]!.id, group[i]!.id));
    }
  }

  // near-duplicates via LSH banding over MinHash signatures
  const sigs: { r: (typeof rows)[number]; sig: Int32Array }[] = [];
  for (const r of rows) {
    const sig = signature(r.text);
    if (sig) sigs.push({ r, sig });
  }
  const BANDS = 16;
  const ROWS_PER_BAND = SIG_LEN / BANDS;
  const buckets = new Map<string, number[]>();
  sigs.forEach((e, idx) => {
    for (let b = 0; b < BANDS; b++) {
      let key = `${b}:`;
      for (let k = 0; k < ROWS_PER_BAND; k++) key += `${e.sig[b * ROWS_PER_BAND + k]},`;
      const arr = buckets.get(key);
      if (arr) arr.push(idx);
      else buckets.set(key, [idx]);
    }
  });
  const candidates = new Set<string>();
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue;
    // A bucket shared by very many blocks is boilerplate, not a duplicate pair
    if (arr.length > 40) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) candidates.add(`${arr[i]}:${arr[j]}`);
    }
  }
  for (const pair of candidates) {
    const [iStr, jStr] = pair.split(':');
    const A = sigs[Number(iStr)]!;
    const B = sigs[Number(jStr)]!;
    if (A.r.note_path === B.r.note_path) continue;
    if (emitted.has(pairKey(A.r.id, B.r.id))) continue;
    const J = sigSimilarity(A.sig, B.sig);
    if (J >= JACCARD_THRESHOLD && J < 1) {
      emitted.add(pairKey(A.r.id, B.r.id));
      out.push(
        orientedPair(
          { notePath: A.r.note_path, anchor: A.r.anchor },
          { notePath: B.r.note_path, anchor: B.r.anchor },
          Number(J.toFixed(3)),
        ),
      );
    }
  }
  // Ties broken by path so the report is a function of the vault, not of the
  // order rows happen to sit in. Findings are frequently tied — every exact
  // duplicate scores 1 — and the fallback was block id, which follows edit
  // history: the same vault indexed incrementally and from scratch wrote
  // different review queues, into a file people keep in git.
  out.sort(
    (x, y) =>
      y.jaccard - x.jaccard ||
      cmp(x.a.notePath, y.a.notePath) ||
      cmp(x.a.anchor, y.a.anchor) ||
      cmp(x.b.notePath, y.b.notePath) ||
      cmp(x.b.anchor, y.b.anchor),
  );
  return out;
}

function findContradictions(ctx: LoreContext): ContradictionFinding[] {
  const db = ctx.store.db;
  const out: ContradictionFinding[] = [];
  // contested: same slot, same effective start, different objects
  const contested = db
    .prepare(
      `SELECT subject, predicate, COALESCE(valid_from, recorded_at) AS start,
              GROUP_CONCAT(object, ' ||| ') AS objs, COUNT(*) AS c
       FROM facts GROUP BY subject, predicate, start HAVING c > 1`,
    )
    .all() as { subject: string; predicate: string; start: string; objs: string }[];
  for (const r of contested) {
    const objects = [...new Set(r.objs.split(' ||| '))];
    if (objects.length < 2) continue;
    out.push({
      subject: r.subject,
      predicate: r.predicate,
      objects,
      kind: 'contested',
      detail: `both asserted effective ${r.start} — needs a human ruling`,
    });
  }
  // recent supersessions (last 14 days): surfaced so changes are visible
  const recent = db
    .prepare(
      `SELECT f.subject, f.predicate, f.object AS oldObj, g.object AS newObj,
              f.superseded_at, g.valid_from AS newFrom
       FROM facts f JOIN facts g ON g.id = f.superseded_by
       WHERE f.superseded_at IS NOT NULL AND f.superseded_at >= ?`,
    )
    .all(new Date(Date.now() - 14 * 86_400_000).toISOString()) as {
    subject: string;
    predicate: string;
    oldObj: string;
    newObj: string;
    superseded_at: string;
    newFrom: string | null;
  }[];
  for (const r of recent) {
    // Selected by RECORD time — "what did we learn recently" — but described
    // by VALID time, because that is when the thing actually changed. The two
    // differ whenever a fact is backdated, which is most of the time: writing
    // up June's handover in August is ordinary, and reporting it as
    // "Senior Engineer → Staff Engineer (August)" is simply false. Importing a
    // year of history in one sitting used to report every change as today's.
    //
    // The same distinction the staleness detector already respects, where a
    // freshly recorded backdated fact is deliberately not called stale.
    const recorded = r.superseded_at.slice(0, 10);
    const effective = r.newFrom ? r.newFrom.slice(0, 10) : null;
    const when =
      effective && effective !== recorded
        ? `effective ${effective}, recorded ${recorded}`
        : recorded;
    out.push({
      subject: r.subject,
      predicate: r.predicate,
      objects: [r.oldObj, r.newObj],
      kind: 'recent-supersession',
      detail: `"${r.oldObj}" → "${r.newObj}" (${when})`,
    });
  }
  return out;
}

/**
 * Important-but-fading knowledge: blocks whose retrievability has dropped
 * below the threshold despite mattering, plus long-untouched open facts.
 * Exported as the single definition of "needs review" — `lore review` and
 * the dream pass must never disagree about what is fading.
 */
export function findStale(
  ctx: LoreContext,
  opts: { rThreshold?: number; importanceMin?: number } = {},
): StaleFinding[] {
  const rThreshold = opts.rThreshold ?? 0.3;
  const importanceMin = opts.importanceMin ?? 0.6;
  const now = new Date();
  const decay = vaultDecay(ctx.store);
  const out: StaleFinding[] = [];
  const blocks = ctx.store.db
    .prepare(
      `SELECT note_path, anchor, importance, stability, last_accessed
       FROM blocks WHERE archived=0 AND importance >= ?`,
    )
    .all(importanceMin) as {
    note_path: string;
    anchor: string;
    importance: number;
    stability: number;
    last_accessed: string | null;
  }[];
  for (const b of blocks) {
    if (!b.last_accessed) continue; // never accessed → nothing decayed yet
    const R = retrievability(daysBetween(b.last_accessed, now), b.stability, decay);
    if (R < rThreshold) {
      out.push({
        kind: 'block',
        ref: `${b.note_path}#${b.anchor}`,
        importance: b.importance,
        retrievability: Number(R.toFixed(3)),
        detail: 'important but fading — revisit or archive',
      });
    }
  }
  // Gate on recorded_at (when WE learned it), not valid_from. Gating on
  // valid_from marks a correctly backdated fact stale the instant it is
  // recorded, which inverts the whole point of the bitemporal model.
  const oldFacts = ctx.store.db
    .prepare(
      `SELECT subject_display, predicate, object, recorded_at AS start
       FROM facts WHERE valid_until IS NULL AND superseded_by IS NULL
       AND recorded_at <= ?`,
    )
    .all(new Date(Date.now() - 180 * 86_400_000).toISOString()) as {
    subject_display: string;
    predicate: string;
    object: string;
    start: string;
  }[];
  for (const f of oldFacts) {
    out.push({
      kind: 'fact',
      ref: `${f.subject_display} :: ${f.predicate} :: ${f.object}`,
      detail: `open since ${f.start.slice(0, 10)} — still true?`,
    });
  }
  return out;
}

/** Entities mentioned in more notes than this are hubs: no signal, O(n^2) noise. */
const HUB_NOTE_CAP = 50;
const MAX_SUGGESTIONS = 30;
const MAX_PER_SOURCE = 3;

function findLinkSuggestions(ctx: LoreContext): LinkSuggestion[] {
  const db = ctx.store.db;
  const noteCount = (db.prepare(`SELECT COUNT(*) c FROM notes`).get() as any).c as number;
  if (noteCount < 2) return [];

  // Document frequency per entity. Entities appearing in very many notes
  // ("README", "Step") generate quadratically many meaningless pairs and
  // swamp real evidence, so they are excluded outright.
  const df = new Map<number, number>();
  const dfRows = db
    .prepare(
      `SELECT entity_id, COUNT(DISTINCT note_path) AS df FROM mentions
       WHERE confidence >= 0.6 GROUP BY entity_id HAVING df >= 2 AND df <= ?`,
    )
    .iterate(HUB_NOTE_CAP) as Iterable<{ entity_id: number; df: number }>;
  for (const r of dfRows) df.set(r.entity_id, r.df);
  if (df.size === 0) return [];

  const notes = db.prepare(`SELECT path, title FROM notes`).all() as {
    path: string;
    title: string;
  }[];
  // Same name resolution the link graph uses: nearest note by path when a name
  // is ambiguous. A one-per-name map credited every `[[Overview]]` to whichever
  // note was enumerated last, so a note whose own folder links to it was
  // reported as an orphan — a false accusation a reader would act on.
  const names = buildNameIndex(notes);
  const resolver = buildNameResolver(names);
  const linked = new Set<string>();
  const links = db.prepare(`SELECT note_path, target_norm FROM links`).all() as {
    note_path: string;
    target_norm: string;
  }[];
  for (const l of links) {
    const dst = resolveNoteName(names, l.target_norm, l.note_path, resolver);
    if (!dst) continue;
    linked.add(`${l.note_path} ${dst}`);
    linked.add(`${dst} ${l.note_path}`);
  }

  // Stream the co-mention join rather than materializing it: on a few-thousand
  // note vault the full pair list runs to gigabytes.
  //
  // Streaming bounded the MEMORY; it did nothing about the work. The join is
  // a self-join on mentions, so an entity appearing in K notes emits K²/2
  // pairs — and a vault has hub entities by nature. Measured: a 20 000-note
  // vault did not finish this pass in ten minutes, while 1 000 notes took two
  // seconds; the cost is quadratic in the commonest entity, not in the vault.
  //
  // The bound is also the better semantics, and the same argument entityIdf
  // makes for the graph: an entity in more than √n notes is background, not
  // evidence that two particular notes belong together. Those pairs were
  // already being weighted down to near-nothing by IDF after being generated
  // at full cost — this declines to generate them.
  const pairCap = Math.max(30, Math.ceil(Math.sqrt(noteCount)));
  interface Acc {
    score: number;
    keys: { key: string; idf: number }[];
  }
  const pairs = new Map<string, Acc>();
  const rows = db
    .prepare(
      `WITH informative AS (
         SELECT entity_id FROM mentions WHERE confidence >= 0.6
         GROUP BY entity_id HAVING COUNT(DISTINCT note_path) BETWEEN 2 AND ${pairCap}
       )
       SELECT m1.note_path AS a, m2.note_path AS b, e.id AS eid, e.key AS key
       FROM mentions m1
       JOIN mentions m2 ON m1.entity_id = m2.entity_id AND m1.note_path < m2.note_path
       JOIN entities e ON e.id = m1.entity_id
       WHERE m1.entity_id IN (SELECT entity_id FROM informative)
         AND m1.confidence >= 0.6 AND m2.confidence >= 0.6
       GROUP BY a, b, eid`,
    )
    .iterate() as Iterable<{ a: string; b: string; eid: number; key: string }>;
  for (const r of rows) {
    const d = df.get(r.eid);
    if (d === undefined) continue;
    const pair = `${r.a} ${r.b}`;
    if (linked.has(pair)) continue;
    // A note's own name is not evidence that it relates to another note.
    // Membership rather than a single owner: when several notes answer to a
    // name, the name belongs to all of them, and picking one let the other be
    // "linked to itself by name" without being caught.
    const owners = names.get(r.key);
    if (owners && (owners.includes(r.a) || owners.includes(r.b))) continue;
    const idf = Math.log(noteCount / d);
    if (idf <= 0) continue;
    const acc = pairs.get(pair);
    if (acc) {
      acc.score += idf;
      acc.keys.push({ key: r.key, idf });
    } else {
      pairs.set(pair, { score: idf, keys: [{ key: r.key, idf }] });
    }
  }

  // How many distinct entities each note mentions, for length normalization.
  const noteSize = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT note_path, COUNT(DISTINCT entity_id) AS n FROM mentions
       WHERE confidence >= 0.6 GROUP BY note_path`,
    )
    .all() as { note_path: string; n: number }[]) {
    noteSize.set(r.note_path, r.n);
  }

  const ranked: LinkSuggestion[] = [];
  for (const [pair, acc] of pairs) {
    if (acc.keys.length < 2) continue;
    const sp = pair.indexOf(' ');
    const from = pair.slice(0, sp);
    const to = pair.slice(sp + 1);
    acc.keys.sort((x, y) => y.idf - x.idf);
    // Normalize by note size. Raw IDF-sum rewards long documents: two
    // sprawling notes about the same project inevitably share vocabulary, so
    // on a 5-note corpus every pair was "related to" every other pair. This
    // asks whether they share MORE than their length alone predicts.
    const denom = Math.sqrt((noteSize.get(from) ?? 1) * (noteSize.get(to) ?? 1)) || 1;
    ranked.push({
      from,
      to,
      // rank on ALL the evidence; show only the strongest few
      sharedEntities: acc.keys.slice(0, 6).map((k) => k.key),
      sharedCount: acc.keys.length,
      score: Number((acc.score / denom).toFixed(4)),
    });
  }
  ranked.sort((x, y) => y.score - x.score || cmp(x.from, y.from) || cmp(x.to, y.to));

  // Suppress suggestions that carry no signal.
  //
  // On a densely interlinked vault (a Zettelkasten of small atomic notes),
  // every pair shares a couple of co-cited neighbours, so thousands of pairs
  // score almost identically and the "top" 30 are arbitrary. A suggestion the
  // reader cannot act on is worse than no suggestion, so a pair must stand
  // clearly above the typical candidate to be worth showing.
  if (ranked.length >= 20) {
    const median = ranked[Math.floor(ranked.length / 2)]!.score;
    if (median > 0) {
      const floor = median * 2;
      const strong = ranked.filter((r) => r.score >= floor);
      // If nothing stands out, the honest answer is that there is nothing.
      ranked.length = 0;
      ranked.push(...strong);
    }
  }

  // Cap per source note so one busy note cannot fill the entire report.
  const perSource = new Map<string, number>();
  const out: LinkSuggestion[] = [];
  for (const s of ranked) {
    const n = perSource.get(s.from) ?? 0;
    if (n >= MAX_PER_SOURCE) continue;
    perSource.set(s.from, n + 1);
    out.push(s);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

function findOrphans(ctx: LoreContext): string[] {
  const db = ctx.store.db;
  const notes = db.prepare(`SELECT path, title FROM notes`).all() as {
    path: string;
    title: string;
  }[];
  const names = buildNameIndex(notes);
  const resolver = buildNameResolver(names);
  const hasLink = new Set<string>();
  const links = db.prepare(`SELECT note_path, target_norm FROM links`).all() as {
    note_path: string;
    target_norm: string;
  }[];
  for (const l of links) {
    hasLink.add(l.note_path);
    const dst = resolveNoteName(names, l.target_norm, l.note_path, resolver);
    if (dst) hasLink.add(dst);
  }
  return notes
    .map((n) => n.path)
    .filter((p) => !hasLink.has(p) && !p.startsWith('lore/'))
    .sort(cmp);
}

const DISPLAY_CAP = 50;

export function dream(ctx: LoreContext, opts: { apply?: boolean } = {}): DreamReport {
  const db = ctx.store.db;
  const count = (sql: string): number => (db.prepare(sql).get() as any).c as number;

  // Merge the full-text index's segments.
  //
  // Every edit to a note deletes and reinserts its blocks, and FTS5 writes a
  // new segment each time rather than updating in place. They are never merged
  // on their own, so search slows down for as long as the vault is used and
  // never recovers: measured on a 200-note vault, twenty rounds of editing
  // took 300 searches from 103 ms to 126 ms, and merging brought it to 94 ms —
  // below the original, because the merged segments are denser than the ones
  // a first index leaves behind.
  //
  // This belongs here rather than in `index`: it is maintenance with no effect
  // on results, which is what this pass is for. It is also cheap enough not to
  // need a schedule — 1 ms on 200 notes, 8 ms on 2 000.
  try {
    db.exec(`INSERT INTO blocks_fts(blocks_fts) VALUES('optimize')`);
  } catch {
    // A merge is never worth failing a consolidation report over; the index is
    // correct either way, just slower.
  }

  const duplicates = findDuplicates(ctx);
  // Every list is ordered deterministically before it is reported or written:
  // the review queue lands in the user's vault, and a report that reshuffles
  // itself on an unchanged vault is a diff they have to read to find out it
  // says nothing.
  const contradictions = findContradictions(ctx).sort(
    (a, b) => cmp(a.kind, b.kind) || cmp(a.subject, b.subject) || cmp(a.predicate, b.predicate) || cmp(a.detail, b.detail),
  );
  const stale = findStale(ctx).sort((a, b) => cmp(a.kind, b.kind) || cmp(a.ref, b.ref));
  const linkSuggestions = findLinkSuggestions(ctx);
  const orphans = findOrphans(ctx);

  const factCount = count(`SELECT COUNT(*) c FROM facts`);
  const accessEvents = count(`SELECT COUNT(*) c FROM access_log`);
  const inactive: string[] = [];
  if (factCount === 0) inactive.push('contradictions', 'stale-facts');
  if (accessEvents === 0) inactive.push('stale-blocks');

  const report: DreamReport = {
    generatedAt: new Date().toISOString(),
    stats: {
      notes: count(`SELECT COUNT(*) c FROM notes`),
      blocks: count(`SELECT COUNT(*) c FROM blocks`),
      entities: count(`SELECT COUNT(*) c FROM entities`),
      facts: factCount,
      openFacts: count(
        `SELECT COUNT(*) c FROM facts WHERE valid_until IS NULL AND superseded_by IS NULL`,
      ),
      accessEvents,
    },
    duplicates: duplicates.slice(0, DISPLAY_CAP),
    contradictions: contradictions.slice(0, DISPLAY_CAP),
    stale: stale.slice(0, DISPLAY_CAP),
    linkSuggestions,
    orphans: orphans.slice(0, DISPLAY_CAP),
    written: [],
    totals: {
      duplicates: duplicates.length,
      contradictions: contradictions.length,
      stale: stale.length,
      linkSuggestions: linkSuggestions.length,
      orphans: orphans.length,
    },
    inactive,
  };

  // Fit the vault's forgetting-curve shape from its own retrieved→used
  // history (FSRS-6's trainable decay; see dynamics/fit.ts). Idle-time work
  // in the sleep-time-compute sense: off the query path, into the cache —
  // the fitted value is derived state in .lore, rebuildable like the rest.
  const fit = fitDecay(ctx.store);
  if (fit !== null) {
    storeDecay(ctx.store, fit.decay);
    report.decayFit = fit;
  }

  if (opts.apply) {
    const date = report.generatedAt.slice(0, 10);
    const digestRel = `lore/digests/${date}.md`;
    // Contained the same way capture is: a symlinked `lore/` would otherwise
    // put generated files outside the vault the user pointed at.
    const digestAbs = safeVaultPath(ctx.root, digestRel, { followSymlinks: false });
    mkdirSync(dirname(digestAbs), { recursive: true });
    // append-only: never overwrite an existing digest silently
    if (!existsSync(digestAbs)) {
      appendFileSync(digestAbs, renderDigest(report), 'utf8');
      report.written.push(digestRel);
    }
    // The queue is REWRITTEN, not appended: blind appending duplicated every
    // finding on each run. Items the user already ticked off are carried
    // forward as done so their work is never lost.
    const queueRel = `lore/review-queue.md`;
    const queueAbs = safeVaultPath(ctx.root, queueRel, { followSymlinks: false });
    const done = new Set<string>();
    if (existsSync(queueAbs)) {
      for (const line of readFileSync(queueAbs, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^- \[x\]\s+(.*)$/i);
        if (m && m[1]) done.add(m[1].trim());
      }
    }
    writeFileSync(queueAbs, renderReviewQueue(report, done), 'utf8');
    report.written.push(queueRel);
  }
  return report;
}

export function renderDigest(r: DreamReport): string {
  const s = r.stats;
  return `---
title: Lore Digest ${r.generatedAt.slice(0, 10)}
tags: [lore-digest]
---

# Vault digest — ${r.generatedAt.slice(0, 10)}

${s.notes} notes · ${s.blocks} blocks · ${s.entities} entities · ${s.openFacts}/${s.facts} facts open · ${s.accessEvents} access events.

- Duplicate passages: ${r.totals.duplicates}
- Contradictions / recent changes: ${r.totals.contradictions}
- Stale items needing review: ${r.totals.stale}
- Suggested missing links: ${r.totals.linkSuggestions}
- Orphan notes: ${r.totals.orphans}

See lore/review-queue.md for the actionable list.
`;
}

/**
 * Render the review queue. `done` carries forward items the user already
 * ticked, so regenerating the file never resurrects settled work.
 */
export function renderReviewQueue(r: DreamReport, done: ReadonlySet<string> = new Set()): string {
  const items: string[] = [];
  for (const c of r.contradictions) {
    items.push(`${c.kind}: **${c.subject} :: ${c.predicate}** — ${c.detail}`);
  }
  for (const s of r.stale) items.push(`stale ${s.kind}: ${s.ref} — ${s.detail}`);
  for (const d of r.duplicates) {
    items.push(
      `duplicate: ${d.a.notePath}#${d.a.anchor} ≈ ${d.b.notePath}#${d.b.anchor} (J=${d.jaccard})`,
    );
  }
  for (const l of r.linkSuggestions) {
    items.push(
      `link? [[${l.from}]] ↔ [[${l.to}]] (${l.sharedCount} shared: ${l.sharedEntities.join(', ')})`,
    );
  }
  for (const o of r.orphans) items.push(`orphan: [[${o}]] — no links in or out`);

  const head = [
    `---`,
    `title: Lore Review Queue`,
    `tags: [lore-review]`,
    `---`,
    ``,
    `# Review queue`,
    ``,
    `Regenerated ${r.generatedAt.slice(0, 16).replace('T', ' ')} — ticked items are kept.`,
    ``,
  ];
  const body = items.length
    ? items.map((i) => `- [${done.has(i) ? 'x' : ' '}] ${i}`)
    : ['- nothing to review 🎉'];
  // keep ticked items that no longer appear, so history is not silently lost
  const shown = new Set(items);
  const retired = [...done].filter((d) => !shown.has(d));
  if (retired.length) {
    body.push('', '## Resolved earlier', ...retired.map((d) => `- [x] ${d}`));
  }
  return [...head, ...body].join('\n') + '\n';
}
