#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openContext, ensureIndexed, type LoreContext } from '../context.js';
import { configIndexOptions, indexState, indexVault } from '../index/indexer.js';
import { isReadonlyError, readonlyError } from '../store/db.js';
import { search } from '../retrieve/search.js';
import {
  aggregateFacts,
  assertFact,
  invalidateFact,
  queryFacts,
} from '../facts/model.js';
import { dream, findStale } from '../dream/dream.js';
import { capture, readNoteRaw } from '../capture.js';
import { markUsed, resolveBlockIds } from '../dynamics/usage.js';
import { findVaultRoot } from '../config.js';
import { watchVault } from '../watch.js';
import { extractFactsFromNote } from '../facts/extract.js';
import { buildTimeline } from '../temporal/timeline.js';
import { resumeDelta } from '../resume.js';
import { normalizeKey } from '../normalize.js';
import { createRequire } from 'node:module';

function text(data: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      { type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) },
    ],
  };
}

function errText(message: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}

/**
 * Wrap a handler so domain errors surface as MCP tool errors, not crashes.
 * A raw SQLite read-only failure from a write tool is reported as the one
 * line naming the index path, the same one the CLI prints.
 */
function safeWith(dbPath: string) {
  return <A extends unknown[]>(
    fn: (...args: A) => unknown | Promise<unknown>,
  ): ((...args: A) => Promise<ReturnType<typeof text> | ReturnType<typeof errText>>) =>
    async (...args: A) => {
      try {
        const r = await fn(...args);
        return text(r);
      } catch (err) {
        return errText(
          isReadonlyError(err) ? readonlyError(dbPath).message : (err as Error).message,
        );
      }
    };
}

/**
 * The version reported in the MCP handshake, read from package.json rather than
 * written out again here. The CLI carried its own hardcoded copy until 0.36.2,
 * where it had drifted a full minor version behind; this is the same string in
 * the same trap, and every connecting client sees it.
 */
export const mcpServerVersion: string = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version;

/** The fields an agent acts on; score internals stay behind verbose. */
export function leanHit(h: {
  notePath: string;
  heading: string;
  coverage: number;
  lexicalScore: number;
  snippet: string;
  parts: { dense: number };
  via: string[];
}) {
  return {
    note: h.notePath,
    section: h.heading || undefined,
    // The reason this result is here, named honestly. Falling through to
    // 'linked, no term match' whenever coverage was zero attributed correct
    // semantic hits to a graph edge that need not exist — and an agent reads
    // that as grounds to discard the whole set.
    match:
      h.coverage >= 0.99
        ? 'all query terms'
        : h.coverage > 0
          ? `${Math.round(h.coverage * 100)}% of query terms`
          : h.lexicalScore > 0
            ? 'weak — query had no distinctive words'
            : h.parts.dense > 0
              ? 'semantic match — no query terms in common'
              : h.via.length > 0
                ? 'linked, no term match'
                : 'no direct match — ranked by graph and recency',
    text: h.snippet,
    ...(h.via.length ? { linkedVia: h.via } : {}),
  };
}

export function createLoreMcpServer(ctx: LoreContext): McpServer {
  const server = new McpServer({ name: 'loreweave', version: mcpServerVersion });
  const safe = safeWith(ctx.store.path);

  server.registerTool(
    'lore_search',
    {
      title: 'Search the vault',
      description:
        'Hybrid retrieval over the markdown vault: BM25 + knowledge-graph spreading activation (+ dense embeddings when configured). Returns one passage per note — the section that best covers your query — with the file it came from, how much of your query it matched, and any entity that linked it in. Use for any "what do my notes say about X" question, including multi-hop associations where the answer shares no words with the query. Pass verbose:true only if you need score internals.',
      inputSchema: {
        query: z.string().min(1).max(2000).describe('natural-language query'),
        k: z.number().int().min(1).max(50).optional().describe('max results (default 8)'),
        since: z.string().optional().describe('only content dated on/after this ISO date'),
        until: z.string().optional().describe('only content dated on/before this ISO date'),
        tags: z.array(z.string()).optional()
          .describe('only notes carrying every listed tag; prefix a tag with "-" to exclude it'),
        folder: z.string().optional()
          .describe('only notes under this vault-relative folder, e.g. "projects/"'),
        verbose: z.boolean().optional().describe('include score breakdown and block anchors'),
      },
    },
    safe(async ({ query, k, since, until, tags, folder, verbose }) => {
      const hits = await search(ctx, query, { k, since, until, tags, folder });
      if (verbose) return hits;
      // Lean by default: an agent acts on the text and its source, not on
      // five floats. Measured, the full shape cost ~1,290 tokens per search —
      // most of it score internals at 17 significant digits.
      return hits.map(leanHit);
    }),
  );

  server.registerTool(
    'lore_context_pack',
    {
      title: 'Session context pack',
      description:
        'Progressive-disclosure primer: vault stats, top entities, recently modified notes, currently-valid facts, and (if topic given) top search hits. Call once at session start to orient; then drill down with lore_search / lore_read_note. Every list here is a sample: when one is cut, a `truncated` field names it with { shown, of, rest } and the tool to call for the remainder — so treat a missing item as "not in this sample", never as "not in the vault".',
      inputSchema: {
        topic: z.string().max(2000).optional().describe('optional focus topic'),
      },
    },
    safe(async ({ topic }) => {
      const db = ctx.store.db;
      const c = (sql: string) => (db.prepare(sql).get() as any).c as number;
      const FACT_LIMIT = 30;
      const RECENT_LIMIT = 10;
      const ENTITY_LIMIT = 15;
      const recent = db
        .prepare(`SELECT path, title FROM notes ORDER BY mtime_ms DESC LIMIT ${RECENT_LIMIT}`)
        .all();
      const topEntities = db
        .prepare(
          `SELECT e.display, COUNT(*) n FROM mentions m JOIN entities e ON e.id=m.entity_id
           GROUP BY e.id ORDER BY n DESC LIMIT ${ENTITY_LIMIT}`,
        )
        .all();
      const factRows = queryFacts(ctx.store, { limit: FACT_LIMIT });
      const facts = factRows.map(
        (f) => `${f.subjectDisplay} :: ${f.predicate} :: ${f.object} (since ${f.validFrom ?? '?'})`,
      );
      const hits = topic ? (await search(ctx, topic, { k: 6 })).map(leanHit) : [];
      const stats = {
        notes: c('SELECT COUNT(*) c FROM notes'),
        blocks: c('SELECT COUNT(*) c FROM blocks'),
        entities: c('SELECT COUNT(*) c FROM entities'),
        openFacts: c(
          'SELECT COUNT(*) c FROM facts WHERE valid_until IS NULL AND superseded_by IS NULL',
        ),
        // ensureIndexed repairs a half-built index at startup, so this can
        // only appear when repair was impossible (a read-only .lore). Then
        // these counts describe the INDEX and not the vault, and an agent
        // reading "notes: 1548" for a 3 000-note vault has nothing else to
        // go on. An added key breaks no consumer; no existing field moves.
        ...(indexState(ctx.store) === 'interrupted' ? { indexIncomplete: true } : {}),
      };
      // Say when a list is a sample rather than the whole set, and what to
      // call for the rest. Every list here is capped, and an agent handed 30
      // of 120 facts with nothing to indicate it will answer "we have no
      // record of that" — a truncation that reads as completeness is worse
      // than a long list, because it is indistinguishable from an answer.
      const truncated: Record<string, { shown: number; of: number; rest: string }> = {};
      if (stats.openFacts > facts.length) {
        truncated.currentFacts = {
          shown: facts.length,
          of: stats.openFacts,
          rest: 'lore_query_facts',
        };
      }
      if (stats.notes > recent.length) {
        truncated.recentNotes = { shown: recent.length, of: stats.notes, rest: 'lore_search' };
      }
      if (stats.entities > topEntities.length) {
        truncated.topEntities = {
          shown: topEntities.length,
          of: stats.entities,
          rest: 'lore_search',
        };
      }
      return {
        stats,
        recentNotes: recent,
        topEntities,
        currentFacts: facts,
        topicHits: hits,
        ...(Object.keys(truncated).length ? { truncated } : {}),
      };
    }),
  );

  server.registerTool(
    'lore_read_note',
    {
      title: 'Read a note',
      description:
        'Read the raw markdown of a note by vault-relative path (as returned in search results). After reading a note that answered the question, call lore_mark_used to reinforce it.',
      inputSchema: { path: z.string().min(1).max(1024).describe('vault-relative path, e.g. projects/x.md') },
    },
    safe(({ path }) => readNoteRaw(ctx.root, path, ctx.config.ignore)),
  );

  server.registerTool(
    'lore_assert_fact',
    {
      title: 'Assert a fact',
      description:
        'Record an atomic fact (subject :: predicate :: object) with bitemporal validity. Contradicting facts in the same slot are superseded automatically (never deleted; history stays queryable). The fact is journalled to lore/journal/ in markdown, so the vault remains the source of truth. Use for durable knowledge: decisions, states, preferences, relationships.',
      inputSchema: {
        subject: z.string().min(1).max(2000),
        predicate: z.string().min(1).max(2000).describe('snake_case relation, e.g. works_at, status, lives_in'),
        object: z.string().min(1).max(2000),
        validFrom: z.string().optional().describe('ISO date when it became true (default today)'),
        validUntil: z.string().optional().describe('ISO date when it stops being true, if known'),
        confidence: z.number().min(0).max(1).optional(),
        sourceType: z.enum(['stated', 'extracted', 'inferred']).optional()
          .describe('stated: user said it · extracted: from a document · inferred: your deduction'),
      },
    },
    safe((input) => assertFact(ctx, input)),
  );

  server.registerTool(
    'lore_invalidate_fact',
    {
      title: 'Invalidate a fact',
      description:
        'Close the currently-valid fact in a (subject, predicate) slot without asserting a replacement — e.g. "no longer true". Journalled; history preserved.',
      inputSchema: {
        subject: z.string().min(1).max(2000),
        predicate: z.string().min(1).max(2000),
        validUntil: z.string().optional().describe('ISO date (default today)'),
      },
    },
    safe((input) => invalidateFact(ctx, input)),
  );

  server.registerTool(
    'lore_resume',
    {
      title: 'Resume a session',
      description:
        'What changed since this tool was last called: notes edited, facts asserted, and knowledge updates (slot: old → new). Call once at session start to continue where the previous session left off — the delta is computed from record time, so the same watermark always yields the same answer. Calling with no `since` consumes the delta (advances the watermark); pass an explicit `since` for a pure read that does not.',
      inputSchema: {
        since: z.string().optional()
          .describe('explicit ISO watermark — pure read, does not advance the session boundary'),
      },
    },
    safe(({ since }) => resumeDelta(ctx.store, { since })),
  );

  server.registerTool(
    'lore_review',
    {
      title: 'What is fading',
      description:
        'Important-but-fading knowledge: blocks whose retrievability has decayed below the threshold despite mattering, plus long-untouched open facts. This is the spaced-repetition loop made operable: review the list, then call lore_mark_used on anything still relevant — use is what reinforces stability. Deterministic, computed from the vault\'s own fitted forgetting curve.',
      inputSchema: {
        threshold: z.number().min(0).max(1).optional()
          .describe('retrievability below this counts as fading (default 0.3)'),
        limit: z.number().int().min(1).max(100).optional().describe('max items (default 20)'),
      },
    },
    safe(({ threshold, limit }) => {
      const items = findStale(ctx, { rThreshold: threshold })
        .sort(
          (a, b) =>
            (b.importance ?? 0) - (a.importance ?? 0) ||
            (a.retrievability ?? 1) - (b.retrievability ?? 1),
        )
        .slice(0, limit ?? 20);
      return { fading: items, reinforceWith: 'lore_mark_used' };
    }),
  );

  server.registerTool(
    'lore_timeline',
    {
      title: 'Entity timeline',
      description:
        'Chronological history of an entity in one call: every value change from the bitemporal fact store (with what each value replaced and when it stopped holding) merged with content-dated passages mentioning the entity. Use for "what happened to X", "what was X before it changed", "history of X" — instead of sampling repeated as-of fact queries and windowed searches.',
      inputSchema: {
        subject: z.string().min(1).max(2000).describe('entity name, e.g. "Project Atlas"'),
        since: z.string().optional().describe('only entries on/after this ISO date'),
        until: z.string().optional().describe('only entries on/before this ISO date'),
      },
    },
    safe(({ subject, since, until }) => buildTimeline(ctx.store, subject, { since, until })),
  );

  server.registerTool(
    'lore_query_facts',
    {
      title: 'Query facts',
      description:
        'Query the bitemporal fact store. Default: currently-valid facts. asOf answers "what was true on DATE", asKnownAt answers "what did we know on DATE"; includeHistory shows the full supersession chain. Prefer this over lore_search for factual slots (status, location, role, preference).',
      inputSchema: {
        subject: z.string().optional(),
        predicate: z.string().optional(),
        asOf: z.string().optional().describe('ISO date: what was TRUE on this date'),
        asKnownAt: z
          .string()
          .optional()
          .describe(
            'ISO date: what was KNOWN on this date. Facts recorded later are excluded however far back their validity was backdated — use it to reconstruct what a past decision was based on. Combine with asOf for "what was true then, as far as we knew then".',
          ),
        includeHistory: z.boolean().optional(),
      },
    },
    safe((q) => queryFacts(ctx.store, q)),
  );

  server.registerTool(
    'lore_aggregate_facts',
    {
      title: 'Count facts',
      description:
        'Deterministic aggregation over fact history — counts grouped by object/subject/predicate with date-range filters. Use for "how many X", "which Y most often" questions; similarity search cannot answer these reliably. Returns { groups, totalGroups, limit }: `groups` is the top `limit` (default 100), so read `totalGroups` for "how many distinct values are there" rather than counting `groups`, and raise `limit` if you need the tail.',
      inputSchema: {
        subject: z.string().optional(),
        predicate: z.string().optional(),
        groupBy: z.enum(['object', 'subject', 'predicate']).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe('max groups returned (default 100); totalGroups always reports the real count'),
      },
    },
    safe((q) => aggregateFacts(ctx.store, q)),
  );

  server.registerTool(
    'lore_capture',
    {
      title: 'Capture a note',
      description:
        'Append a timestamped line to lore/inbox.md (or another vault note). Use for fleeting observations worth keeping that are not atomic facts. The captured text is searchable immediately. Never overwrites anything, and never writes outside the vault — a path that escapes it, including through a symlink, is refused.',
      inputSchema: {
        text: z.string().min(1).max(100_000),
        to: z.string().max(1024).optional().describe('target .md path (default lore/inbox.md)'),
      },
    },
    safe(({ text: t, to }) => ({ captured: capture(ctx, t, to) })),
  );

  server.registerTool(
    'lore_mark_used',
    {
      title: 'Mark passage as used',
      description:
        'Reinforce passages that actually contributed to your answer (spaced-repetition signal: used memories decay slower). Call after citing a note.',
      inputSchema: {
        notePath: z.string().min(1).max(1024),
        anchor: z.string().max(1024).optional().describe('block anchor from search results; omit for whole note'),
      },
    },
    safe(({ notePath, anchor }) => ({
      reinforced: markUsed(ctx.store, resolveBlockIds(ctx.store, notePath, anchor)),
    })),
  );

  server.registerTool(
    'lore_dream_report',
    {
      title: 'Consolidation report',
      description:
        'Run the consolidation pass: duplicate passages, contradicting/recently-changed facts, stale knowledge needing review, suggested missing links, orphan notes. Leaves the vault untouched unless apply=true (which writes a digest + review queue under lore/); it does perform index maintenance either way, which changes no results. Findings are a summary — pass verbose:true for every one.',
      inputSchema: {
        apply: z.boolean().optional(),
        verbose: z.boolean().optional().describe('return every finding rather than a summary'),
      },
    },
    safe(({ apply, verbose }) => {
      const r = dream(ctx, { apply });
      if (verbose) return r;
      // A summary plus the few findings worth acting on. The full report ran
      // to ~2,600 tokens, most of it long tails nobody reads in one sitting.
      return {
        stats: r.stats,
        totals: r.totals,
        inactive: r.inactive,
        contradictions: r.contradictions.slice(0, 5),
        stale: r.stale.slice(0, 5),
        duplicates: r.duplicates.slice(0, 5).map((d) => ({
          a: `${d.a.notePath}#${d.a.anchor}`,
          b: `${d.b.notePath}#${d.b.anchor}`,
          similarity: d.jaccard,
        })),
        linkSuggestions: r.linkSuggestions.slice(0, 5).map((l) => ({
          from: l.from,
          to: l.to,
          sharedCount: l.sharedCount,
          shared: l.sharedEntities.slice(0, 4),
        })),
        orphans: r.orphans.slice(0, 10),
        written: r.written,
        note: 'summary — pass verbose:true for every finding',
      };
    }),
  );


  server.registerTool(
    'lore_propose_facts',
    {
      title: 'Propose facts from a note',
      description:
        'Returns candidate facts mined from a note\'s structure that are NOT yet in the fact store, for you to adjudicate. The engine only auto-accepts unambiguous field syntax (frontmatter, `key:: value`, `- [key] value`); prose formatting like `- **Owner:** Priya` is precise on entity notes and noisy on report notes, so it is surfaced here instead of assumed. Review these and call lore_assert_fact for the ones that are genuinely durable facts. This keeps judgement with you and out of the index.',
      inputSchema: {
        notePath: z.string().max(1024).optional().describe('limit to one note; omit to sample the vault'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    safe(({ notePath, limit }) => {
      const rows = (
        notePath
          ? ctx.store.db
              .prepare(`SELECT path, title, frontmatter, mtime_ms FROM notes WHERE path=?`)
              .all(notePath)
          : ctx.store.db
              .prepare(`SELECT path, title, frontmatter, mtime_ms FROM notes ORDER BY mtime_ms DESC LIMIT 50`)
              .all()
      ) as { path: string; title: string; frontmatter: string; mtime_ms: number }[];
      if (notePath && rows.length === 0) throw new Error(`no such note: ${notePath}`);
      const blocksFor = ctx.store.db.prepare(
        `SELECT anchor, heading, ord, text, hash FROM blocks WHERE note_path=? ORDER BY ord`,
      );
      const existing = new Set(
        (
          ctx.store.db.prepare(`SELECT subject, predicate, object FROM facts`).all() as {
            subject: string;
            predicate: string;
            object: string;
          }[]
        ).map((r) => `${r.subject}|${r.predicate}|${r.object.toLowerCase()}`),
      );
      const out: unknown[] = [];
      const cap = limit ?? 50;
      for (const n of rows) {
        let fm: Record<string, unknown> = {};
        try {
          fm = JSON.parse(n.frontmatter) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        const note = {
          path: n.path,
          title: n.title,
          frontmatter: fm,
          tags: [],
          links: [],
          blocks: blocksFor.all(n.path),
          hash: '',
          mtimeMs: n.mtime_ms,
          size: 0,
          warnings: [],
        } as never;
        for (const f of extractFactsFromNote(note, 'all')) {
          const key = `${normalizeKey(f.subject)}|${normalizeKey(f.predicate)}|${f.object.toLowerCase()}`;
          if (existing.has(key)) continue;
          out.push({
            subject: f.subject,
            predicate: f.predicate,
            object: f.object,
            source: `${n.path}${f.blockAnchor ? '#' + f.blockAnchor : ''}`,
            confidence: f.confidence,
          });
          if (out.length >= cap) break;
        }
        if (out.length >= cap) break;
      }
      return { candidates: out, note: 'not yet asserted — call lore_assert_fact for the real ones' };
    }),
  );

  server.registerTool(
    'lore_index',
    {
      title: 'Reindex the vault',
      description:
        'Incrementally sync the markdown vault into the index. Call after writing files to the vault through anything OTHER than lore_* tools (an editor, another agent, plain fs writes) — the lore_* write tools index their own writes, so their content is searchable immediately without this.',
      inputSchema: { full: z.boolean().optional() },
    },
    safe(async ({ full }) => {
      const r = await indexVault(ctx.store, ctx.root, { ...configIndexOptions(ctx.config), full });
      ctx.invalidateGraph();
      return r;
    }),
  );

  return server;
}

export async function startMcpServer(ctx: LoreContext): Promise<void> {
  // Before serving a single request. An agent handed an empty index does not
  // get an error it can react to — it gets `[]`, and reports to the user that
  // they have nothing written on the subject.
  await ensureIndexed(
    ctx,
    (n) => console.error(`[loreweave mcp] first run: indexing ${n} notes…`),
    (n) =>
      console.error(
        `[loreweave mcp] previous index did not finish (${n} notes indexed); rebuilding…`,
      ),
  );
  const server = createLoreMcpServer(ctx);
  // Watch the vault for the whole life of the server. This process runs for a
  // session, and the user edits notes in their editor while an agent searches
  // through it: without the watcher, those searches answered from whatever the
  // vault looked like at startup — measured, a note saved while the server ran
  // was simply unfindable, indefinitely, with nothing to say so. The watch
  // module's own rationale ("a question an agent cannot think about at all")
  // applies to no process more than this one.
  const watcher = watchVault(ctx, {
    onError: (err) => console.error(`[loreweave mcp] watch: ${err.message}`),
  });
  const transport = new StdioServerTransport();
  // Without these the server goes permanently deaf on a malformed or
  // oversized message, with an empty stderr and exit code 0 — the worst
  // possible failure mode for something an agent depends on.
  transport.onerror = (err: Error) => {
    console.error(`[loreweave mcp] transport error: ${err.message}`);
    try {
      watcher.close();
      ctx.close();
    } finally {
      process.exit(1);
    }
  };
  transport.onclose = () => {
    try {
      watcher.close();
      ctx.close();
    } finally {
      process.exit(0);
    }
  };
  await server.connect(transport);
  // keep process alive; close store on exit
  const shutdown = () => {
    try {
      watcher.close();
      ctx.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// direct exec: `node dist/mcp/server.js [vaultPath]`
const argv1 = process.argv[1] ?? '';
if (/server\.(ts|js)$/.test(argv1)) {
  const root = process.argv[2] ? process.argv[2] : findVaultRoot(process.cwd());
  const ctx = openContext(root);
  startMcpServer(ctx).catch((err) => {
    console.error(`loreweave mcp failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
