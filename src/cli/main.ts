#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { openContext, ensureIndexed, type LoreContext } from '../context.js';
import { isReadonlyError, readonlyError, verifyOrReset } from '../store/db.js';
import { LORE_DIR, dbPath, findVaultRoot } from '../config.js';
import { contentTerms, normalizeKey } from '../normalize.js';
import { parseQueryTime } from '../temporal/dates.js';
import { buildTimeline } from '../temporal/timeline.js';
import { resumeDelta } from '../resume.js';
import { configIndexOptions, indexVault, indexState } from '../index/indexer.js';
import { bestSnippet, search } from '../retrieve/search.js';
import {
  aggregateFacts,
  assertFact,
  invalidateFact,
  queryFacts,
} from '../facts/model.js';
import { dream, findStale } from '../dream/dream.js';
import { capture } from '../capture.js';
import { markUsed, resolveBlockIds } from '../dynamics/usage.js';
import { buildSimilarEdges, embedMissingBlocks } from '../embed/index.js';
import { exportGraph } from './export.js';
import { display } from './display.js';
import { watchVault } from '../watch.js';

/**
 * A numeric option parser that refuses NaN.
 *
 * Bare parseInt/parseFloat let a typo through as NaN, and every comparison
 * with NaN is false — so `review --limit x` sliced to nothing and printed
 * "nothing is fading", an affirmative all-clear on a vault that had fading
 * items, exit 0. That is the failure assertIsoDate exists to prevent for
 * dates. The MCP layer has zod; the CLI had nothing.
 */
function num(
  flag: string,
  opts: { int?: boolean; min?: number; max?: number } = {},
): (raw: string) => number {
  return (raw: string): number => {
    const v = opts.int ? parseInt(raw, 10) : parseFloat(raw);
    if (!Number.isFinite(v)) {
      throw new InvalidArgumentError(`${flag} must be a number, got: ${raw}`);
    }
    if (opts.min !== undefined && v < opts.min) {
      throw new InvalidArgumentError(`${flag} must be >= ${opts.min}, got: ${raw}`);
    }
    if (opts.max !== undefined && v > opts.max) {
      throw new InvalidArgumentError(`${flag} must be <= ${opts.max}, got: ${raw}`);
    }
    return v;
  };
}

/**
 * True when a passage is nothing but this project's own fact-record syntax.
 * Used only by `ask`, and only when the facts themselves are being shown —
 * `search` still returns journals, because searching for a record should find
 * the record.
 */
function isFactRecord(snippet: string): boolean {
  const lines = snippet.split(/\n|(?= - \[(?:fact|invalidate)\])/i)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((l) => /^[-*+]?\s*\[(fact|invalidate)\]/i.test(l));
}

/** Label absolute match strength so a bullseye and a miss don't look alike. */
export function strength(r: {
  coverage: number;
  lexicalScore: number;
  parts: { dense: number };
  via: string[];
}): string {
  if (r.coverage >= 0.99) return 'all terms';
  if (r.coverage >= 0.6) return `${Math.round(r.coverage * 100)}% of terms`;
  if (r.coverage > 0) return `${Math.round(r.coverage * 100)}% of terms — weak`;
  if (r.lexicalScore > 0) return 'partial';
  // Zero lexical coverage used to mean "linked only" unconditionally, which
  // named a graph edge even when the vault had no links and the result came
  // from the embedding index. Say which signal actually put it here.
  if (r.parts.dense > 0) return 'semantic — no shared words';
  if (r.via.length > 0) return 'linked only';
  return 'no direct match';
}

/** How a fact came to exist, in one readable line. */
function provenance(f: {
  sourceType: string;
  notePath: string | null;
  blockAnchor: string | null;
  confidence: number;
}): string {
  const origin =
    f.sourceType === 'stated'
      ? 'asserted'
      : f.sourceType === 'inferred'
        ? 'inferred'
        : 'from note';
  const where = f.notePath ? `${f.notePath}${f.blockAnchor ? `#${f.blockAnchor}` : ''}` : 'unknown';
  const conf = f.confidence < 0.85 ? `  ~${Math.round(f.confidence * 100)}% confidence` : '';
  return `${origin} · ${where}${conf}`;
}

/**
 * A readable location line.
 *
 * The raw anchor is the full heading breadcrumb, which on a deeply nested
 * research note ran to 327 characters and buried the score and the snippet.
 * Show the file and the innermost heading — that is what identifies the
 * passage to a reader. `--json` still carries the exact anchor.
 */
function fmtLocation(notePath: string, anchor: string): string {
  const heading = anchor.replace(/@\d+$/, '');
  if (!heading) return notePath;
  const leaf = heading.split('/').filter(Boolean).pop() ?? '';
  if (!leaf) return notePath;
  const short = leaf.length > 60 ? `${leaf.slice(0, 57).trimEnd()}…` : leaf;
  return `${notePath} › ${short}`;
}

function fmtResult(r: {
  notePath: string;
  anchor: string;
  score: number;
  lexicalScore: number;
  coverage: number;
  snippet: string;
  parts: { dense: number };
  via: string[];
}): string {
  const via = r.via.length ? `  ⟨via ${r.via.join(', ')}⟩` : '';
  // Path, heading, link names and snippet all come out of the vault; the
  // frame around them is the only part of this line the engine wrote.
  return display(`• ${fmtLocation(r.notePath, r.anchor)}  [${strength(r)}]${via}\n  ${r.snippet}`);
}

export function buildProgram(io: { out: (s: string) => void; err: (s: string) => void }): Command {
  const program = new Command();
  program
    .name('lore')
    .description(
      'Loreweave — a temporal knowledge engine for markdown vaults.\nIndexes, links, remembers, forgets, and dreams. Local-first, agent-ready.',
    )
    .version(createRequire(import.meta.url)('../../package.json').version)
    .option('--vault <path>', 'vault root (default: nearest .lore, else cwd)');

  const vaultRoot = (): string => {
    const opt = program.opts<{ vault?: string }>().vault;
    return opt ? resolve(opt) : findVaultRoot(process.cwd());
  };

  /**
   * `autoIndex: true` for the commands that answer questions about note
   * CONTENT, so none of them can answer from an index that was never built.
   *
   * Opt-in rather than opt-out. Commands that report on the index itself
   * (`doctor`, `stats`) must show the true state including "empty", and
   * commands that only write (`assert`, `capture`) do not need the note index
   * at all — auto-indexing there meant a mistyped date spent a full pass over
   * the vault before reporting the typo.
   */
  const withCtx = async <T>(
    fn: (ctx: LoreContext) => Promise<T> | T,
    opts: { autoIndex?: boolean } = {},
  ): Promise<T> => {
    const ctx = openContext(vaultRoot());
    try {
      if (opts.autoIndex) {
        await ensureIndexed(
          ctx,
          (n) => console.error(`[loreweave] first run: indexing ${n} notes…`),
          (n) =>
            io.err(
              `[loreweave] previous index did not finish (${n} notes indexed); rebuilding…`,
            ),
        );
        // Here rather than per-command, so search, ask, timeline, dream and
        // every other autoIndex command gets it. It only fires when the
        // rebuild above could not run — a read-only index — because otherwise
        // the state is clean by now. stderr, not stdout: the caveat must not
        // land in output a script is parsing.
        if (indexState(ctx.store) === 'interrupted') {
          io.err(
            'index: INCOMPLETE (a previous index did not finish) — results describe the partial index, not the vault; run `lore index`',
          );
        }
      }
      return await fn(ctx);
    } catch (err) {
      // Writes that go straight to the database (mark-used, resume's
      // watermark, dream --apply) surface SQLite's raw "attempt to write a
      // readonly database"; say which file and what to do instead.
      if (isReadonlyError(err)) throw readonlyError(ctx.store.path);
      throw err;
    } finally {
      ctx.close();
    }
  };

  program
    .command('init')
    .description('initialize .lore/ in the current directory')
    .action(() => {
      const root = program.opts<{ vault?: string }>().vault
        ? resolve(program.opts<{ vault?: string }>().vault!)
        : process.cwd();
      const dir = join(root, LORE_DIR);
      mkdirSync(dir, { recursive: true });
      const cfgPath = join(dir, 'config.json');
      if (!existsSync(cfgPath)) {
        writeFileSync(
          cfgPath,
          JSON.stringify(
            {
              embedding: { provider: 'none', model: 'nomic-embed-text', url: 'http://localhost:11434' },
              // explicit: mine frontmatter + `key:: value` + `- [key] value`
              // all: also mine `- **Key:** value` prose formatting (noisier)
              facts: { extract: 'explicit' },
              nlp: true,
            },
            null,
            2,
          ) + '\n',
        );
      }
      io.out(`Initialized ${join(root, LORE_DIR)}`);
      io.out(`Next: lore index   (then: lore search "..." · lore dream · lore serve --mcp)`);
      io.out(`Tip: set embedding.provider to "ollama" in .lore/config.json for dense retrieval.`);
    });

  program
    .command('index')
    .description('sync the vault into the index (incremental)')
    .option('--full', 'reparse everything')
    .option('--no-nlp', 'skip NLP entity extraction')
    .option('--rebuild-similar', 'rebuild embedding similarity edges (all-pairs; slow)')
    .action(async (opts: { full?: boolean; nlp?: boolean; rebuildSimilar?: boolean }) => {
      await withCtx(async (ctx) => {
        const r = await indexVault(ctx.store, ctx.root, {
          ...configIndexOptions(ctx.config),
          full: opts.full,
          // `--no-nlp` can only turn NLP off. Commander gives a negatable flag
          // a default of true, and passing that through overrode a config
          // that had turned it off — the file said false, the index ran NLP.
          nlp: ctx.config.nlp && opts.nlp !== false,
        });
        ctx.invalidateGraph();
        io.out(
          `indexed: +${r.added} ~${r.updated} -${r.removed} =${r.unchanged} (${r.durationMs}ms)`,
        );
        for (const w of r.warnings) io.err(`warn: ${w}`);
        if (ctx.provider) {
          // The embedding pass is the slow half of an index run and printed
          // nothing at all until it finished — indistinguishable from a stalled
          // provider, which benchmarks.md explicitly warns about. Ticks go to
          // stderr so stdout and --json stay byte-identical, at most one a
          // second, and none at all for a run short enough not to need them.
          let lastTick = 0;
          const n = await embedMissingBlocks(
            ctx.store,
            ctx.provider,
            ctx.config.embedding.batchSize,
            (done, total) => {
              if (done >= total) return; // the summary line below reports the end
              const now = Date.now();
              if (now - lastTick < 1000) return;
              lastTick = now;
              io.err(`embedding ${done}/${total} blocks…`);
            },
          );
          if (n > 0) io.out(`embedded ${n} blocks`);
          // Similarity edges are an all-pairs rebuild — measured ~1.07µs per
          // comparison, i.e. hours on a 20k-block vault. Editing one note must
          // never trigger that, so it is opt-in (or run from `lore dream`).
          if (opts.rebuildSimilar) {
            const e = buildSimilarEdges(ctx.store, {
              threshold: ctx.config.graph.similarThreshold,
              topK: ctx.config.graph.similarTopK,
            });
            io.out(`rebuilt ${e} similarity edges`);
          } else if (n > 0) {
            io.out(`(similarity edges not refreshed — run: lore index --rebuild-similar)`);
          }
        }
      });
    });

  program
    .command('search')
    .description('hybrid search (BM25 + graph + dense when configured)')
    .argument('<query...>')
    .option('-k, --k <n>', 'results', num('-k', { int: true, min: 1 }))
    .option('--since <date>', 'only content dated on/after ISO date')
    .option('--until <date>', 'only content dated on/before ISO date')
    .option(
      '--tag <tag>',
      'only notes with this tag; -tag excludes (repeatable)',
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option('--folder <path>', 'only notes under this vault folder')
    .option('--json', 'JSON output')
    .action(
      async (
        words: string[],
        opts: {
          k?: number;
          since?: string;
          until?: string;
          tag?: string[];
          folder?: string;
          json?: boolean;
        },
      ) => {
      await withCtx(async (ctx) => {
        const res = await search(ctx, words.join(' '), {
          k: opts.k,
          since: opts.since,
          until: opts.until,
          tags: opts.tag?.length ? opts.tag : undefined,
          folder: opts.folder,
        });
        if (opts.json) {
          io.out(JSON.stringify(res, null, 2));
        } else if (res.length === 0) {
          io.out('no results');
        } else {
          const best = Math.max(...res.map((r) => r.coverage));
          if (best <= 0) {
            // Same correction as the per-result label: do not announce links
            // that may not exist. Say which signal actually produced the set.
            const anyDense = res.some((r) => r.parts.dense > 0);
            const anyLink = res.some((r) => r.via.length > 0);
            io.out(
              anyDense
                ? 'no term matched — showing semantically similar notes:'
                : anyLink
                  ? 'no term matched — showing linked neighbours only:'
                  : 'no term matched — showing the closest notes:',
            );
          } else if (best < 0.6) {
            io.out(`no strong match — best covers ${Math.round(best * 100)}% of your terms:`);
          }
          io.out(res.map(fmtResult).join('\n'));
        }
      }, { autoIndex: true });
    },
    );

  program
    .command('ask')
    .description('extractive answer: top passages + current facts (no LLM required)')
    .argument('<query...>')
    .option('--json', 'JSON output')
    .action(async (words: string[], opts: { json?: boolean }) => {
      await withCtx(async (ctx) => {
        const q = words.join(' ');
        // A question about the past must not be answered with today's facts.
        const when = parseQueryTime(q);
        const factQuery =
          when.kind === 'asOf'
            ? { asOf: when.date }
            : when.kind === 'history'
              ? { includeHistory: true }
              : {};
        const [passages, facts] = [
          await search(ctx, q, { k: 5 }),
          queryFacts(ctx.store, factQuery),
        ];
        // Match facts on content words only, and on whole words — substring
        // matching on short tokens surfaced unrelated facts (a query about
        // "companies" matched a fact whose object merely contained "s").
        const qTokens = contentTerms(q).filter((t) => t.length >= 3);
        const hasTerm = (haystack: string, t: string) =>
          new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(haystack);
        const relevantFacts = facts
          .filter((f) =>
            qTokens.some(
              (t) => hasTerm(f.subject, t) || hasTerm(f.predicate, t) || hasTerm(f.object, t),
            ),
          )
          .slice(0, 8);
        if (opts.json) {
          io.out(JSON.stringify({ passages, facts: relevantFacts }, null, 2));
          return;
        }
        if (relevantFacts.length) {
          io.out(
            when.kind === 'asOf'
              ? `Facts (as of ${when.date}):`
              : when.kind === 'history'
                ? 'Facts (full history):'
                : 'Facts (currently valid):',
          );
          for (const f of relevantFacts) {
            const from = f.validFrom ? ` (since ${f.validFrom.slice(0, 10)})` : '';
            const until = f.validUntil ? ` until ${f.validUntil.slice(0, 10)}` : '';
            io.out(display(`  ★ ${f.subjectDisplay} — ${f.predicate} — ${f.object}${from}${until}`));
          }
          io.out('');
        }
        // When the facts are already printed above, the journal lines that
        // RECORD those facts are not a second answer — they are the same
        // answer in the syntax the engine writes for itself. Measured, `ask`
        // showed `- [fact] Project Atlas :: status :: shipped {valid_from=…,
        // recorded_at=…, confidence=0.9}` as its top passage, directly beneath
        // a Facts section that had already said it in words. This grows with
        // use: every assert appends another line to an indexed journal.
        const shown = relevantFacts.length
          ? passages.filter((p) => !isFactRecord(p.snippet))
          : passages;
        if (shown.length) {
          io.out('Passages:');
          io.out(shown.map(fmtResult).join('\n'));
        }
        if (!relevantFacts.length && !shown.length) io.out('nothing found');
      }, { autoIndex: true });
    });

  program
    .command('facts')
    .description('query the bitemporal fact store')
    .option('--subject <s>')
    .option('--predicate <p>')
    .option('--as-of <date>', 'what was true on this date')
    .option('--as-known-at <date>', 'what we BELIEVED on this date (record time)')
    .option('--history', 'include superseded facts')
    .option('--json', 'JSON output')
    .action(async (opts: {
      subject?: string;
      predicate?: string;
      asOf?: string;
      asKnownAt?: string;
      history?: boolean;
      json?: boolean;
    }) => {
      await withCtx((ctx) => {
        const rows = queryFacts(ctx.store, {
          subject: opts.subject,
          predicate: opts.predicate,
          asOf: opts.asOf,
          asKnownAt: opts.asKnownAt,
          includeHistory: opts.history,
        });
        if (opts.json) {
          io.out(JSON.stringify(rows, null, 2));
          return;
        }
        if (!rows.length) {
          io.out('no facts');
          return;
        }
        for (const f of rows) {
          const window = `${f.validFrom?.slice(0, 10) ?? '…'} → ${f.validUntil?.slice(0, 10) ?? 'now'}`;
          const sup = f.supersededBy ? '  [superseded]' : '';
          io.out(display(`${f.subjectDisplay} :: ${f.predicate} :: ${f.object}  (${window})${sup}`));
          // A fact with no visible source cannot be checked, and "where did
          // this come from" is the first thing anyone asks of a fact an
          // engine produced rather than a human typed.
          io.out(display(`    ${provenance(f)}`));
        }
      });
    });

  program
    .command('resume')
    .description('what changed since the last resume: notes, facts, supersessions')
    .option('--since <datetime>', 'explicit watermark (pure read; does not advance)')
    .option('--json', 'JSON output')
    .action(async (opts: { since?: string; json?: boolean }) => {
      await withCtx((ctx) => {
        const d = resumeDelta(ctx.store, { since: opts.since });
        if (opts.json) {
          io.out(JSON.stringify(d, null, 2));
          return;
        }
        io.out(`since ${d.since.slice(0, 16).replace('T', ' ')}`);
        const { notesChanged, factsAsserted, factsSuperseded } = d.counts;
        if (!notesChanged && !factsAsserted && !factsSuperseded) {
          io.out('nothing changed');
          return;
        }
        for (const n of d.notesChanged) io.out(`~ ${n.path}`);
        for (const f of d.factsAsserted) io.out(`+ ${f}`);
        for (const s of d.factsSuperseded) io.out(`± ${s.slot}: ${s.old} → ${s.new}`);
        if (d.truncated) {
          for (const [k, t] of Object.entries(d.truncated)) {
            io.out(`… ${k}: showing ${t.shown} of ${t.of}`);
          }
        }
      });
    });

  program
    .command('review')
    .description('important-but-fading knowledge: revisit it or archive it')
    .option('--threshold <r>', 'retrievability below this is fading (default 0.3)', num('--threshold', { min: 0, max: 1 }))
    .option('--limit <n>', 'max items (default 20)', num('--limit', { int: true, min: 1 }))
    .option('--json', 'JSON output')
    .action(async (opts: { threshold?: number; limit?: number; json?: boolean }) => {
      await withCtx((ctx) => {
        const items = findStale(ctx, { rThreshold: opts.threshold })
          .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (a.retrievability ?? 1) - (b.retrievability ?? 1))
          .slice(0, opts.limit ?? 20);
        if (opts.json) {
          io.out(JSON.stringify(items, null, 2));
          return;
        }
        if (!items.length) {
          io.out('nothing is fading — everything important has been touched recently');
          return;
        }
        for (const it of items) {
          const r = it.retrievability !== undefined ? `  R=${it.retrievability}` : '';
          io.out(`• ${it.ref}${r}\n  ${it.detail}`);
        }
        io.out('');
        io.out('reinforce what still matters: lore mark-used <note> [anchor]');
      });
    });

  program
    .command('timeline')
    .description('chronological history of an entity: fact changes merged with dated mentions')
    .argument('<subject...>', 'entity name')
    .option('--since <date>', 'only entries on/after this ISO date')
    .option('--until <date>', 'only entries on/before this ISO date')
    .option('--json', 'JSON output')
    .action(
      async (subjectWords: string[], opts: { since?: string; until?: string; json?: boolean }) => {
        await withCtx((ctx) => {
          const subject = subjectWords.join(' ');
          const tl = buildTimeline(ctx.store, subject, { since: opts.since, until: opts.until });
          if (opts.json) {
            io.out(JSON.stringify(tl, null, 2));
            return;
          }
          if (!tl.length) {
            io.out(`no history for "${subject}" — no facts recorded and no dated mentions`);
            return;
          }
          for (const e of tl) {
            if (e.kind === 'change') {
              const arrow = e.previous ? `${e.previous} → ${e.value}` : String(e.value);
              const until = e.until === null ? '' : `  (until ${e.until})`;
              io.out(display(`${e.date}  ${e.predicate}: ${arrow}${until}`));
            } else {
              // Show the line that MENTIONS the subject, not whatever the
              // block starts with — a table block's first line is
              // "| Skill | Proficiency |", unreadable as a history entry
              // (same lesson bestSnippet taught search).
              const line =
                bestSnippet(e.text ?? '', contentTerms(subject), 100) ||
                ((e.text ?? '').split('\n').find((l) => l.trim()) ?? '');
              const snip = line.length > 100 ? `${line.slice(0, 100)}…` : line;
              io.out(display(`${e.date}  • ${snip}  [${e.notePath}]`));
            }
          }
        });
      },
    );

  program
    .command('assert')
    .description('assert a fact (journalled, supersedes contradictions)')
    .argument('<subject>')
    .argument('<predicate>')
    .argument('<object...>')
    .option('--valid-from <date>')
    .option('--valid-until <date>')
    .option('--confidence <n>', 'confidence 0..1', num('--confidence', { min: 0, max: 1 }))
    .action(async (
      subject: string,
      predicate: string,
      objectWords: string[],
      opts: { validFrom?: string; validUntil?: string; confidence?: number },
    ) => {
      await withCtx((ctx) => {
        const r = assertFact(ctx, {
          subject,
          predicate,
          object: objectWords.join(' '),
          validFrom: opts.validFrom,
          validUntil: opts.validUntil,
          confidence: opts.confidence,
        });
        io.out(display(`✓ ${r.fact.subjectDisplay} :: ${r.fact.predicate} :: ${r.fact.object}`));
        for (const s of r.superseded) io.out(display(`  superseded: "${s.object}" (now valid until ${s.validUntil})`));
        io.out(`  journal: ${r.journalPath}`);
      });
    });

  program
    .command('invalidate')
    .description('close the current fact in a slot (journalled)')
    .argument('<subject>')
    .argument('<predicate>')
    .option('--valid-until <date>')
    .action(async (subject: string, predicate: string, opts: { validUntil?: string }) => {
      await withCtx((ctx) => {
        const r = invalidateFact(ctx, { subject, predicate, validUntil: opts.validUntil });
        io.out(`closed ${r.closed} fact(s) · journal: ${r.journalPath}`);
      });
    });

  program
    .command('count')
    .description('aggregate facts (the computable layer)')
    .option('--subject <s>')
    .option('--predicate <p>')
    .option('--group-by <col>', 'object|subject|predicate', 'object')
    .option('--since <date>')
    .option('--until <date>')
    .action(async (opts: {
      subject?: string;
      predicate?: string;
      groupBy?: string;
      since?: string;
      until?: string;
    }) => {
      await withCtx((ctx) => {
        const agg = aggregateFacts(ctx.store, {
          subject: opts.subject,
          predicate: opts.predicate,
          groupBy: (opts.groupBy as 'object' | 'subject' | 'predicate') ?? 'object',
          since: opts.since,
          until: opts.until,
        });
        if (!agg.groups.length) io.out('no facts');
        for (const r of agg.groups) io.out(`${String(r.count).padStart(5)}  ${r.group}`);
        // Counting is the point of this command, so a capped list has to say
        // it is capped — otherwise "how many distinct values" is answered with
        // the limit, and it looks like an answer.
        if (agg.totalGroups > agg.groups.length) {
          io.out(`  … showing the top ${agg.groups.length} of ${agg.totalGroups} groups`);
        }
      });
    });

  program
    .command('capture')
    .description('append a timestamped note to lore/inbox.md')
    .argument('<text...>')
    .option('--to <note>', 'target note path', 'lore/inbox.md')
    .action(async (words: string[], opts: { to: string }) => {
      await withCtx((ctx) => {
        const to = capture(ctx, words.join(' '), opts.to);
        io.out(`captured → ${to}`);
      });
    });

  program
    .command('dream')
    .description('consolidation pass: duplicates, contradictions, staleness, links, orphans')
    .option('--apply', 'write digest + review queue under lore/')
    .option('--json', 'JSON output')
    .action(async (opts: { apply?: boolean; json?: boolean }) => {
      await withCtx((ctx) => {
        const r = dream(ctx, { apply: opts.apply });
        if (opts.json) {
          io.out(JSON.stringify(r, null, 2));
          return;
        }
        const s = r.stats;
        io.out(
          `state: ${s.notes} notes · ${s.blocks} blocks · ${s.entities} entities · ${s.openFacts}/${s.facts} facts open`,
        );
        // Report true totals, and say "n/a" where a detector has no inputs
        // rather than "0", which reads as a clean bill of health.
        const na = (name: string, n: number) =>
          r.inactive.includes(name) ? 'n/a' : String(n);
        io.out(
          `findings: ${na('duplicates', r.totals.duplicates)} duplicates · ` +
            `${na('contradictions', r.totals.contradictions)} contradictions/changes · ` +
            `${r.inactive.includes('stale-facts') && r.inactive.includes('stale-blocks') ? 'n/a' : r.totals.stale} stale · ` +
            `${r.totals.linkSuggestions} link suggestions · ${r.totals.orphans} orphans`,
        );
        if (r.inactive.length) {
          io.out(`  (n/a = detector has no input yet: ${[...new Set(r.inactive)].join(', ')})`);
        }
        for (const c of r.contradictions.slice(0, 10)) {
          io.out(`  ⚡ ${c.subject} :: ${c.predicate} — ${c.detail}`);
        }
        // Every finding type shows examples, not just a count. Reporting
        // "6 duplicates · 23 orphans" and then listing only link suggestions
        // left the other two actionable only via --apply, which writes files
        // into the vault — so looking required changing.
        const more = (shown: number, total: number, what: string) =>
          total > shown ? `  … and ${total - shown} more ${what}` : null;
        for (const d of r.duplicates.slice(0, 3)) {
          io.out(`  ⧉ dup?  ${d.a.notePath}#${d.a.anchor}`);
          io.out(`       ≈  ${d.b.notePath}#${d.b.anchor}  (J=${d.jaccard})`);
        }
        const dupMore = more(Math.min(3, r.duplicates.length), r.totals.duplicates, 'duplicates');
        if (dupMore) io.out(dupMore);
        for (const s of r.stale.slice(0, 3)) io.out(`  ◷ stale? ${s.ref} — ${s.detail}`);
        for (const l of r.linkSuggestions.slice(0, 5)) {
          io.out(
            `  ✦ link? ${l.from} ↔ ${l.to} (${l.sharedCount} shared: ${l.sharedEntities.join(', ')})`,
          );
        }
        const linkMore = more(
          Math.min(5, r.linkSuggestions.length),
          r.totals.linkSuggestions,
          'link suggestions',
        );
        if (linkMore) io.out(linkMore);
        if (r.orphans.length) {
          io.out(`  ⌾ orphan? ${r.orphans.slice(0, 5).join(', ')}`);
          const orphMore = more(
            Math.min(5, r.orphans.length),
            r.totals.orphans,
            'unlinked notes',
          );
          if (orphMore) io.out(orphMore);
        }
        if (r.written.length) io.out(`written: ${r.written.join(', ')}`);
        else if (!opts.apply) io.out(`(run with --apply to write the digest + review queue)`);
      }, { autoIndex: true });
    });

  program
    .command('mark-used')
    .description('reinforce a passage that was actually useful (spaced-repetition signal)')
    .argument('<notePath>')
    .argument('[anchor]')
    .action(async (notePath: string, anchor?: string) => {
      await withCtx((ctx) => {
        const ids = resolveBlockIds(ctx.store, notePath, anchor);
        const n = markUsed(ctx.store, ids);
        io.out(`reinforced ${n} block(s)`);
      }, { autoIndex: true });
    });

  program
    .command('doctor')
    .description('vault health: broken links, integrity, coverage')
    .action(async () => {
      // Deep check first: if the index is damaged it is reset here, then the
      // rest of the report runs against a clean (empty) index.
      const healed = verifyOrReset(dbPath(vaultRoot()), (m) => io.err(`[loreweave] ${m}`));
      await withCtx((ctx) => {
        const db = ctx.store.db;
        const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
        io.out(`db integrity: ${healed ? 'was corrupt — index reset' : (integrity[0]?.integrity_check ?? 'unknown')}`);
        // Everything below reads the index as if it described the vault. On a
        // half-built index it does not, and the numbers are not merely
        // approximate — they are alarming and wrong. Say so first.
        const state = indexState(ctx.store);
        if (state !== 'clean') {
          io.out(
            state === 'running'
              ? 'index: an index is running right now — counts below are a moving target'
              : 'index: INCOMPLETE (a previous index did not finish) — run `lore index`;' +
                ' counts below describe the partial index, not the vault',
          );
        }
        // A link is broken when no NOTE resolves to its target. (Checking
        // against `entities` would never fire: every link target becomes an
        // entity by construction.)
        const notes = db.prepare(`SELECT path, title FROM notes`).all() as {
          path: string;
          title: string;
        }[];
        const resolvable = new Set<string>();
        for (const n of notes) {
          resolvable.add(normalizeKey(n.title));
          resolvable.add(normalizeKey(n.path));
          resolvable.add(normalizeKey(n.path.split('/').pop() ?? n.path));
        }
        const allLinks = db
          .prepare(
            `SELECT DISTINCT note_path, target, target_norm, style FROM links WHERE target != ''`,
          )
          .all() as { note_path: string; target: string; target_norm: string; style: string }[];
        const broken = allLinks.filter((l) => !resolvable.has(l.target_norm));
        if (broken.length) {
          io.out(`broken links: ${broken.length}`);
          // Quote each link the way the file spells it. Rendering a markdown
          // link as `[[target]]` sends the reader grepping for text that is
          // not in their vault, in the one report whose entire purpose is
          // "go fix this line".
          for (const b of broken.slice(0, 20)) {
            const shown = b.style === 'markdown' ? `](${b.target})` : `[[${b.target}]]`;
            io.out(`  ${b.note_path} → ${shown}`);
          }
          if (broken.length > 20) io.out(`  … and ${broken.length - 20} more`);
        } else {
          io.out('broken links: 0');
        }
        const emb = db.prepare(`SELECT COUNT(*) c FROM embeddings`).get() as { c: number };
        const blocks = db.prepare(`SELECT COUNT(*) c FROM blocks`).get() as { c: number };
        io.out(
          `embedding coverage: ${emb.c}/${blocks.c}${ctx.provider ? '' : ' (no provider configured — lexical+graph mode)'}`,
        );
        const lastIndex = ctx.store.getMeta('last_index_at');
        io.out(`last index: ${lastIndex ?? 'never — run: lore index'}`);
      });
    });

  program
    .command('stats')
    .description('vault statistics')
    .action(async () => {
      await withCtx((ctx) => {
        // The same caveat doctor gives: these are index counts, and a
        // half-built index is not a description of the vault.
        if (indexState(ctx.store) === 'interrupted') {
          io.out('index: INCOMPLETE (a previous index did not finish) — run `lore index`');
        }
        const db = ctx.store.db;
        const c = (sql: string) => (db.prepare(sql).get() as any).c as number;
        io.out(`notes:    ${c('SELECT COUNT(*) c FROM notes')}`);
        io.out(`blocks:   ${c('SELECT COUNT(*) c FROM blocks')}`);
        io.out(`entities: ${c('SELECT COUNT(*) c FROM entities')}`);
        io.out(`links:    ${c('SELECT COUNT(*) c FROM links')}`);
        io.out(`facts:    ${c('SELECT COUNT(*) c FROM facts')} (${c("SELECT COUNT(*) c FROM facts WHERE valid_until IS NULL AND superseded_by IS NULL")} open)`);
        const top = db
          .prepare(
            `SELECT e.display, COUNT(*) n FROM mentions m JOIN entities e ON e.id=m.entity_id
             GROUP BY e.id ORDER BY n DESC LIMIT 10`,
          )
          .all() as { display: string; n: number }[];
        io.out('top entities:');
        for (const t of top) io.out(`  ${String(t.n).padStart(4)}  ${t.display}`);
      });
    });

  program
    .command('graph')
    .description('export the knowledge graph')
    .argument('<action>', 'export')
    .option('--format <fmt>', 'json|graphml|dot', 'json')
    .option('-o, --out <file>', 'output file (default: stdout)')
    .option('--force', 'overwrite the output file if it already exists')
    .action(async (action: string, opts: { format: string; out?: string; force?: boolean }) => {
      if (action !== 'export') throw new Error(`unknown graph action: ${action}`);
      await withCtx((ctx) => {
        const text = exportGraph(ctx, opts.format);
        if (opts.out) {
          // The only place this engine writes a path the user typed, and so
          // the only write that can destroy something. Everything else either
          // appends or lives under lore/ and is regenerated. A mistyped
          // `--out notes/atlas.md` overwrote the note and reported success.
          if (existsSync(opts.out) && !opts.force) {
            throw new Error(`${opts.out} already exists — pass --force to overwrite it`);
          }
          writeFileSync(opts.out, text);
          io.out(`wrote ${opts.out}`);
        } else {
          io.out(text);
        }
      }, { autoIndex: true });
    });

  program
    .command('watch')
    .description('reindex automatically as the vault changes (Ctrl-C to stop)')
    .option('--debounce <ms>', 'quiet period before reindexing', num('--debounce', { int: true, min: 0 }))
    .action(async (opts: { debounce?: number }) => {
      const ctx = openContext(vaultRoot());
      const first = await indexVault(ctx.store, ctx.root, configIndexOptions(ctx.config));
      ctx.invalidateGraph();
      io.out(`watching ${ctx.root} (indexed ${first.added + first.updated} notes) — Ctrl-C to stop`);
      const w = watchVault(ctx, {
        debounceMs: opts.debounce,
        onReindex: (r) =>
          io.out(
            `${new Date().toISOString().slice(11, 19)}  +${r.added} ~${r.updated} -${r.removed} (${r.durationMs}ms)`,
          ),
        onError: (e) => io.err(`watch error: ${e.message}`),
      });
      const stop = () => {
        w.close();
        ctx.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      // hold the event loop open
      await new Promise<void>(() => {});
    });

  program
    .command('serve')
    .description('start the MCP server (stdio) so agents can use the vault as memory')
    .option('--mcp', 'stdio MCP mode (default)')
    .action(async () => {
      const { startMcpServer } = await import('../mcp/server.js');
      // NOTE: never write to stdout here — stdio transport owns it
      const ctx = openContext(vaultRoot());
      await startMcpServer(ctx);
    });

  return program;
}

const isDirectRun = (() => {
  try {
    const argv1 = process.argv[1] ?? '';
    return /main\.(ts|js)$/.test(argv1) || /\/(lore|loreweave)$/.test(argv1);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const program = buildProgram({
    out: (s) => console.log(s),
    err: (s) => console.error(s),
  });
  program.parseAsync(process.argv).catch((err: Error) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  });
}
