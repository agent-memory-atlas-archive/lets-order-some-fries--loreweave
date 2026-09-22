import { appendFileSync, mkdirSync } from 'node:fs';
import { indexNoteFile } from '../index/indexer.js';
import { join, dirname } from 'node:path';
import type { LoreContext } from '../context.js';
import type { Store } from '../store/db.js';
import type { Fact } from '../types.js';
import { normalizeKey } from '../normalize.js';
import { assertIsoDate } from '../temporal/dates.js';
import { JOURNAL_DIR, recomputeSupersessions, renderFactLine } from './journal.js';

export interface AssertFactInput {
  subject: string;
  predicate: string;
  object: string;
  /** ISO date/datetime when the fact became true (defaults to today). */
  validFrom?: string;
  validUntil?: string;
  confidence?: number;
  sourceType?: 'stated' | 'extracted' | 'inferred';
}

export interface AssertFactResult {
  fact: Fact;
  /** Facts this assertion superseded (same slot, older validity, different object). */
  superseded: Fact[];
  journalPath: string;
}

const checkDate = assertIsoDate;

/**
 * A fact's slot is (normalizeKey(subject), normalizeKey(predicate)), and
 * normalizeKey keeps only letters and digits. A value made of nothing else —
 * an emoji, a dash, a run of punctuation — normalises to '', and every such
 * value lands in the SAME slot. Measured: `assert 🚀 status launched`, then
 * `assert — status cancelled` reported "superseded: launched", and
 * `invalidate 🎯 status` closed the `—` fact. Three unrelated subjects
 * contradicting one another through a key none of them had. Refuse the key,
 * name the value, and say why, so the caller can add a word to it.
 */
function keyOf(name: 'subject' | 'predicate', value: string): string {
  const key = normalizeKey(value);
  if (!key) {
    throw new Error(
      `${name} "${value.trim()}" normalises to nothing — a fact ${name} needs at least one letter or digit`,
    );
  }
  return key;
}

const GROUP_BY_COLUMNS = { object: 'object', subject: 'subject', predicate: 'predicate' } as const;

function rowToFact(r: Record<string, unknown>): Fact {
  return {
    id: r.id as number,
    subject: r.subject as string,
    predicate: r.predicate as string,
    object: r.object as string,
    subjectDisplay: r.subject_display as string,
    validFrom: (r.valid_from as string) ?? null,
    validUntil: (r.valid_until as string) ?? null,
    recordedAt: r.recorded_at as string,
    supersededAt: (r.superseded_at as string) ?? null,
    supersededBy: (r.superseded_by as number) ?? null,
    sourceType: r.source_type as Fact['sourceType'],
    notePath: (r.note_path as string) ?? null,
    blockAnchor: (r.block_anchor as string) ?? null,
    confidence: r.confidence as number,
  };
}

/** Append a line to today's journal note (creates lore/journal/ as needed). */
function appendJournalLine(root: string, line: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const rel = `${JOURNAL_DIR}/${today}.md`;
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  appendFileSync(abs, `${line}\n`, 'utf8');
  return rel;
}

/**
 * Assert a fact: durable journal line first, then the DB row, then
 * deterministic supersession recompute. Contradictions supersede — never
 * delete (Zep/Graphiti). Freshness resolution is deterministic: newest
 * valid_from wins; the LLM caller is never asked to judge staleness.
 */
/** A fact is an atomic proposition, not a document; unbounded fields make
 *  every downstream pass (journal lines, retrieval, dream) pathological. */
export const MAX_FACT_FIELD = 2000;

/**
 * Stamp a fact row with the anchor of the journal block its line landed in.
 *
 * assertFact inserts the row before the journal note is indexed, so no block
 * exists to point at yet and block_anchor went in NULL; rebuildFactsFromNotes
 * replays the same line out of the indexed note and sets the anchor it finds
 * there. The two write paths disagreed, so a fact's cited source changed the
 * first time anything triggered a replay — which is any re-index that touches
 * any note, not just deleting .lore. Running this AFTER indexNoteFile, once the
 * block rows exist, lands the live path on the anchor the replay would derive.
 *
 * Matching on the full rendered line is exact, and a miss leaves NULL — which
 * is precisely today's behaviour, not a wrong anchor.
 */
function stampBlockAnchor(
  db: Store['db'],
  id: number,
  journalPath: string,
  line: string,
): void {
  db.prepare(
    `UPDATE facts SET block_anchor = (
       SELECT anchor FROM blocks
       WHERE note_path = ? AND instr(text, ?) > 0
       ORDER BY ord DESC LIMIT 1)
     WHERE id = ? AND block_anchor IS NULL`,
  ).run(journalPath, line, id);
}

export function assertFact(ctx: LoreContext, input: AssertFactInput): AssertFactResult {
  if (!input.subject.trim() || !input.predicate.trim() || !input.object.trim()) {
    throw new Error('subject, predicate, and object are required');
  }
  for (const [name, value] of [
    ['subject', input.subject],
    ['predicate', input.predicate],
    ['object', input.object],
  ] as const) {
    if (value.length > MAX_FACT_FIELD) {
      throw new Error(
        `${name} is ${value.length} chars; facts are atomic propositions (max ${MAX_FACT_FIELD}). Use lore capture for long text.`,
      );
    }
  }
  checkDate('validFrom', input.validFrom);
  checkDate('validUntil', input.validUntil);
  const conf = input.confidence ?? 0.9;
  if (conf < 0 || conf > 1) throw new Error('confidence must be in [0,1]');
  const sourceType = input.sourceType ?? 'stated';
  const recordedAt = new Date().toISOString();
  const validFrom = input.validFrom ?? recordedAt.slice(0, 10);
  const subject = keyOf('subject', input.subject);
  const predicate = keyOf('predicate', input.predicate);
  // The journal line is written before the row on purpose — the markdown is
  // the source of truth — so a read-only index has to be refused before
  // either, or the next rebuild replays a fact the user was told was refused.
  ctx.store.assertWritable();

  // Same rule as invalidate: a fact cannot stop being true before it started.
  // Accepted silently this produced intervals like (2025-01-01 → 2024-06-01),
  // which no query can answer and nothing flags.
  if (input.validUntil && validFrom && input.validUntil < validFrom) {
    throw new Error(
      `validUntil ${input.validUntil} is before validFrom ${validFrom}`,
    );
  }
  // Kept in a const because the same text is how the fact is found again in
  // the indexed note, to stamp the block anchor the replay would later derive.
  const journalLine = renderFactLine({
    kind: 'fact',
    subject: input.subject.trim(),
    predicate: input.predicate.trim(),
    object: input.object.trim(),
    attrs: {
      valid_from: validFrom,
      ...(input.validUntil ? { valid_until: input.validUntil } : {}),
      recorded_at: recordedAt,
      confidence: String(conf),
      source: sourceType,
    },
  });
  const journalPath = appendJournalLine(ctx.root, journalLine);

  const db = ctx.store.db;
  const before = db
    .prepare(
      `SELECT id FROM facts WHERE subject=? AND predicate=? AND superseded_by IS NULL`,
    )
    .all(subject, predicate) as { id: number }[];
  // Same identity as the journal replay: slot, value, validity window. Without
  // this the live path inserted a second row for an identical assertion and
  // then closed the first AT ITS OWN START — a zero-length fact — while a
  // rebuild from the journal collapsed the pair into one. Two answers to the
  // same question depending on whether you had reindexed.
  //
  // The journal line is still appended: it is a log of what was said, and
  // saying the same thing twice is a fact about the log, not about the world.
  //
  // Compared against user_valid_until, never valid_until: by the time a
  // duplicate arrives, supersession has usually already closed the original at
  // some later fact's start, so matching on the computed value never fires and
  // the duplicate is inserted anyway. The journal line records what the user
  // claimed, so that is what identity has to be built from.
  const identical = db
    .prepare(
      `SELECT id FROM facts WHERE subject=? AND predicate=? AND object=?
         AND COALESCE(valid_from,'') = COALESCE(?,'')
         AND COALESCE(user_valid_until,'') = COALESCE(?,'')`,
    )
    .get(subject, predicate, input.object.trim(), validFrom, input.validUntil ?? null) as
    | { id: number }
    | undefined;
  if (identical) {
    recomputeSupersessions(ctx.store);
    // The journal line was still appended above — the journal is a log of what
    // was said — so the note still needs its self-index.
    indexNoteFile(ctx.store, ctx.root, journalPath, { nlp: ctx.config.nlp });
    // The re-assertion appended a line to (possibly) a new block, and the kept
    // row may still carry the NULL from before this note was ever indexed.
    stampBlockAnchor(db, identical.id, journalPath, journalLine);
    ctx.invalidateGraph();
    const kept = rowToFact(db.prepare(`SELECT * FROM facts WHERE id=?`).get(identical.id) as any);
    return { fact: kept, superseded: [], journalPath };
  }

  const info = db
    .prepare(
      `INSERT INTO facts(subject, predicate, object, subject_display, valid_from, valid_until,
                         recorded_at, source_type, note_path, block_anchor, confidence,
                         user_valid_until)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      subject,
      predicate,
      input.object.trim(),
      input.subject.trim(),
      validFrom,
      input.validUntil ?? null,
      recordedAt,
      sourceType,
      `${journalPath}`,
      null,
      conf,
      input.validUntil ?? null, // user_valid_until: an explicit close is intent
    );
  recomputeSupersessions(ctx.store);
  // The journal line just appended becomes searchable immediately, matching
  // capture. The fact itself was queryable already; the NOTE was not.
  indexNoteFile(ctx.store, ctx.root, journalPath, { nlp: ctx.config.nlp });

  const id = Number(info.lastInsertRowid);
  stampBlockAnchor(db, id, journalPath, journalLine);
  ctx.invalidateGraph();

  const fact = rowToFact(db.prepare(`SELECT * FROM facts WHERE id=?`).get(id) as any);
  // Records this assertion CLOSED, minus the ones it merely re-confirmed. The
  // chain closes every predecessor so a slot keeps exactly one current value,
  // but re-asserting the same value did not supersede anything in the sense a
  // reader cares about — reporting `superseded: "draft"` when you just wrote
  // "draft" again describes a change that did not happen.
  const superseded = before
    .map((b) => db.prepare(`SELECT * FROM facts WHERE id=? AND superseded_by=?`).get(b.id, id))
    .filter(Boolean)
    .map((r) => rowToFact(r as any))
    .filter((f) => normalizeKey(f.object) !== normalizeKey(input.object));
  return { fact, superseded, journalPath };
}

/** Close all open facts in a slot (journalled + applied). */
export function invalidateFact(
  ctx: LoreContext,
  input: { subject: string; predicate: string; validUntil?: string },
): { closed: number; journalPath: string } {
  checkDate('validUntil', input.validUntil);
  const subject = keyOf('subject', input.subject);
  const predicate = keyOf('predicate', input.predicate);
  ctx.store.assertWritable(); // same reason as assertFact: before the journal line
  const until = input.validUntil ?? new Date().toISOString().slice(0, 10);
  // "It stopped being true before it started" is not a fact, it is a typo.
  // Accepted silently, it produced an interval like (2025-06-01 → 2025-01-01)
  // that no query can answer sensibly and nothing ever flags.
  const target = ctx.store.db
    .prepare(
      `SELECT valid_from FROM facts WHERE subject=? AND predicate=? AND valid_until IS NULL
       ORDER BY COALESCE(valid_from, recorded_at) DESC, recorded_at DESC, id DESC LIMIT 1`,
    )
    .get(subject, predicate) as { valid_from: string | null } | undefined;
  if (target?.valid_from && until < target.valid_from) {
    throw new Error(
      `validUntil ${until} is before the fact became valid (${target.valid_from})`,
    );
  }
  const journalPath = appendJournalLine(
    ctx.root,
    renderFactLine({
      kind: 'invalidate',
      subject: input.subject.trim(),
      predicate: input.predicate.trim(),
      attrs: { valid_until: until },
    }),
  );
  // Same semantics as replay: close only the slot's current winner.
  const res = ctx.store.db
    .prepare(
      `UPDATE facts SET valid_until=?, user_valid_until=? WHERE id IN (
         SELECT id FROM facts WHERE subject=? AND predicate=? AND valid_until IS NULL
         ORDER BY COALESCE(valid_from, recorded_at) DESC, recorded_at DESC, id DESC LIMIT 1
       )`,
    )
    .run(until, until, subject, predicate);
  indexNoteFile(ctx.store, ctx.root, journalPath, { nlp: ctx.config.nlp });
  ctx.invalidateGraph();
  return { closed: res.changes, journalPath };
}

export interface FactQuery {
  subject?: string;
  predicate?: string;
  /** Point-in-time: facts valid at this date ("what was true then"). */
  asOf?: string;
  /**
   * Record-time travel: facts as they were KNOWN at this date ("what did we
   * believe then"), independent of what was true.
   *
   * The store has always kept both axes and only ever let you query one. That
   * is the difference between a fact store with history and a bitemporal one:
   * `asOf` alone rewrites the past every time something is backdated, so it
   * cannot answer why a decision made in March looked right in March. Combine
   * the two for the full question — what was true then, as far as we knew then.
   */
  asKnownAt?: string;
  /** Include superseded/closed facts (full history). */
  includeHistory?: boolean;
  limit?: number;
}

/**
 * Query facts. Default: currently-valid facts only. `asOf` answers
 * point-in-time questions; `includeHistory` returns the full chain.
 */
export function queryFacts(store: Store, q: FactQuery = {}): Fact[] {
  checkDate('asOf', q.asOf);
  checkDate('asKnownAt', q.asKnownAt);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.subject) {
    clauses.push(`subject = ?`);
    params.push(normalizeKey(q.subject));
  }
  if (q.predicate) {
    clauses.push(`predicate = ?`);
    params.push(normalizeKey(q.predicate));
  }
  if (q.asOf) {
    clauses.push(`COALESCE(valid_from, recorded_at) <= ?`);
    params.push(`${q.asOf}~`); // '~' sorts after any time suffix, making date-only asOf inclusive
    clauses.push(`(valid_until IS NULL OR valid_until > ?)`);
    params.push(q.asOf);
  } else if (!q.includeHistory && !q.asKnownAt) {
    clauses.push(`valid_until IS NULL AND superseded_by IS NULL`);
  }
  if (q.asKnownAt) {
    // Known at T: recorded by then, and not yet superseded by then. A fact
    // asserted afterwards was not available to anyone reasoning at T, however
    // early its validity was backdated to start.
    clauses.push(`recorded_at <= ?`);
    params.push(`${q.asKnownAt}~`);
    clauses.push(`(superseded_at IS NULL OR superseded_at > ?)`);
    params.push(`${q.asKnownAt}~`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = store.db
    .prepare(
      `SELECT * FROM facts ${where}
       ORDER BY subject, predicate, COALESCE(valid_from, recorded_at) DESC
       LIMIT ?`,
    )
    .all(...params, q.limit ?? 200) as Record<string, unknown>[];
  return rows.map(rowToFact);
}

export interface AggregateQuery {
  subject?: string;
  predicate?: string;
  groupBy?: 'object' | 'subject' | 'predicate';
  /** Restrict to facts whose validity intersects [since, until]. */
  since?: string;
  until?: string;
  /** Max groups returned (default 100); the total is reported regardless. */
  limit?: number;
}

/**
 * Computable layer: counting/grouping over fact history — the queries
 * similarity retrieval fundamentally cannot answer (User as Code, 2026).
 */
/**
 * Grouped fact counts, with the number of groups that exist.
 *
 * The total is part of the return rather than something a caller may ask for,
 * because the bug this replaces was exactly a caller not asking: the query has
 * always capped at 100 groups and said nothing, so "the computable layer"
 * answered a question about 150 distinct values with 100 rows and no
 * indication. An opt-in total would have been the same design that produced
 * that.
 */
export interface FactAggregate {
  groups: { group: string; count: number }[];
  /** How many groups exist in total; `groups` is the top `limit` of them. */
  totalGroups: number;
  limit: number;
}

export function aggregateFacts(store: Store, q: AggregateQuery = {}): FactAggregate {
  checkDate('since', q.since);
  checkDate('until', q.until);
  const groupBy = q.groupBy ?? 'object';
  // A group-by column arrives from the CLI (`count --group-by X`) unchecked; an
  // unknown value used to index to `undefined` and reach SQLite as
  // `GROUP BY undefined`, surfacing "no such column: undefined" — an internal
  // error leaked as if it were the user's fault. Reject it by name instead.
  const col = GROUP_BY_COLUMNS[groupBy as keyof typeof GROUP_BY_COLUMNS];
  if (!col) {
    throw new Error(
      `group-by must be one of ${Object.keys(GROUP_BY_COLUMNS).join(', ')}, got: ${groupBy}`,
    );
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.subject) {
    clauses.push(`subject = ?`);
    params.push(normalizeKey(q.subject));
  }
  if (q.predicate) {
    clauses.push(`predicate = ?`);
    params.push(normalizeKey(q.predicate));
  }
  // `since`/`until` bound when the fact BECAME true, which is what
  // "how many trips in 2025" means. (Filtering on valid_until instead is
  // trivially true for every still-open fact, so a 2025 window would count
  // a 2024 trip that never ended.)
  if (q.since) {
    clauses.push(`COALESCE(valid_from, recorded_at) >= ?`);
    params.push(q.since);
  }
  if (q.until) {
    clauses.push(`COALESCE(valid_from, recorded_at) <= ?`);
    params.push(`${q.until}~`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = q.limit ?? 100;
  const groups = store.db
    .prepare(
      `SELECT ${col} AS grp, COUNT(*) AS count FROM facts ${where}
       GROUP BY ${col} ORDER BY count DESC, grp ASC LIMIT ?`,
    )
    .all(...params, limit)
    .map((r: any) => ({ group: r.grp as string, count: r.count as number }));
  const totalGroups = (
    store.db
      .prepare(`SELECT COUNT(*) c FROM (SELECT 1 FROM facts ${where} GROUP BY ${col})`)
      .get(...params) as { c: number }
  ).c;
  return { groups, totalGroups, limit };
}
