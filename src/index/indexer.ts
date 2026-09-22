import { readFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IndexReport, Note } from '../types.js';
import type { Store } from '../store/db.js';
import type { LoreConfig } from '../config.js';
import { parseNote, sha1 } from '../vault/parse.js';
import { decodeNote } from '../vault/read.js';
import { isDerivedNote, scanVault } from '../vault/scan.js';
import { extractEntities } from '../entities/extract.js';
import { rebuildFactsFromNotes } from '../facts/journal.js';
import { updateImportance } from '../dynamics/usage.js';

export interface IndexOptions {
  full?: boolean;
  /** Retries when another process holds the write lock (default 5). */
  lockRetries?: number;
  /** Which fact syntaxes to mine (see config.facts.extract). */
  factExtract?: 'explicit' | 'all' | 'off';
  /** Disable wink-nlp proper-noun extraction (faster; links/tags only). */
  nlp?: boolean;
  ignore?: string[];
  /** Index notes whose real file is outside the vault (config followExternalSymlinks). */
  followExternalSymlinks?: boolean;
}

/**
 * The index options a vault's config asks for.
 *
 * Five call sites built this object by hand and each forgot a different key:
 * CLI `lore index` and `lore watch` dropped `ignore`, MCP `lore_index`
 * dropped all three, and the first-run auto-index behind `lore search` used
 * `ignore` to decide whether the vault was empty and then indexed without it.
 * Measured: `"ignore": ["drafts"]` excluded nothing anywhere, and
 * `"nlp": false` was overridden by the CLI flag's default of true. Spread
 * this first; put the command's own overrides after it.
 */
export function configIndexOptions(config: LoreConfig): IndexOptions {
  return {
    factExtract: config.facts.extract,
    nlp: config.nlp,
    ignore: config.ignore,
    followExternalSymlinks: config.followExternalSymlinks,
  };
}

/** Replace all entity mentions derived from one note. */

/**
 * Index one file the engine itself just wrote.
 *
 * `capture` and `assertFact` append to a note and know exactly which one, but
 * the content was not searchable until the next full index — the natural
 * agent sequence "record a fact, then search for it" returned nothing, and
 * the tool description documented the trap instead of removing it.
 *
 * Does the same per-note work as the indexer (parse, upsert, mentions), so a
 * later incremental run sees matching mtime/size and correctly skips it.
 * The batch steps (fact replay, importance) are deliberately not run here:
 * they read blocks from the DATABASE, not from files, so the upserted content
 * is already visible to them whenever the next real index runs — and journal
 * fact lines replay into exactly the fact `assertFact` already inserted, which
 * is the identity the replay property tests pin.
 *
 * Synchronous on purpose: the callers are synchronous, the file was written a
 * moment ago, and better-sqlite3 is synchronous anyway.
 */
export function indexNoteFile(
  store: Store,
  root: string,
  relPath: string,
  opts: { nlp?: boolean } = {},
): void {
  // Mirror scanVault: a derived note (review queue, digests) is never indexed
  // by a full run, so indexing it here would create a note a rebuild deletes —
  // a transient divergence from the disposability property.
  if (isDerivedNote(relPath)) return;
  store.assertWritable();
  const abs = join(root, relPath);
  const st = statSync(abs);
  // The engine wrote this file itself, as UTF-8; the decoder is used so the
  // index has one reading of "text", not for its warning.
  const raw = decodeNote(readFileSync(abs)).text;
  const note = parseNote(relPath, raw, st.mtimeMs, st.size);
  const tx = store.db.transaction(() => {
    store.upsertNote(note);
    writeMentions(store, note, opts.nlp !== false);
  });
  tx();
}

export function writeMentions(store: Store, note: Note, useNlp: boolean): void {
  const db = store.db;
  const mentions = extractEntities(note, useNlp);
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM mentions WHERE note_path=?`).run(note.path);
    const upsertEntity = db.prepare(
      `INSERT INTO entities(key, display) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET display=display RETURNING id`,
    );
    const insMention = db.prepare(
      `INSERT INTO mentions(entity_id, note_path, block_anchor, source, confidence)
       VALUES (?,?,?,?,?)`,
    );
    for (const m of mentions) {
      const row = upsertEntity.get(m.key, m.display) as { id: number };
      insMention.run(row.id, note.path, m.blockAnchor, m.source, m.confidence);
    }
  });
  tx();
}

/** Remove entities that no longer have any mentions (after deletes). */
export function pruneOrphanEntities(store: Store): number {
  const res = store.db
    .prepare(`DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM mentions)`)
    .run();
  return res.changes;
}

/** Is the process that claimed the index still alive? */
/**
 * State of the index-in-progress marker, so callers other than the indexer can
 * tell a half-built index from a healthy one.
 *
 * `doctor` needs this most: on an index interrupted part-way it reported
 * "broken links: 1091" for a vault whose links are all fine, because the notes
 * those links point at had not been indexed yet. A health report that invents
 * a catastrophe is worse than one that says it cannot tell yet.
 */
export function indexState(store: Store): 'clean' | 'interrupted' | 'running' {
  const marker = store.getMeta('index_in_progress');
  if (marker === null || marker === '0') return 'clean';
  const alive = marker === String(process.pid) ? indexInFlight : isRunning(marker);
  return alive ? 'running' : 'interrupted';
}

/**
 * True while an index is genuinely in flight IN THIS PROCESS.
 *
 * `process.kill(pid, 0)` cannot distinguish "I set this marker and then died
 * mid-run" from "I am running right now" — a process can always signal itself.
 * So a marker equal to our own PID is ambiguous, and the only thing that
 * resolves it is knowing whether an index is actually executing. Without this,
 * a mid-run throw (SQLITE_FULL, an IO error) inside a long-lived process —
 * `lore watch` or the MCP server, which both catch the error and keep running —
 * left the own-PID marker behind, the next index read it as "running" not
 * "interrupted", the half-built facts/mentions were never repaired, and the
 * marker was then cleared to 0 so no later run could self-heal either. Exactly
 * the "+0 ~0 -0 forever" failure the marker exists to prevent.
 */
let indexInFlight = false;

function isRunning(marker: string): boolean {
  const pid = Number(marker);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0); // signal 0 only tests existence
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive
    return (err as { code?: string }).code === 'EPERM';
  }
}

function isBusy(err: unknown): boolean {
  const m = (err as Error)?.message ?? '';
  const code = (err as { code?: string })?.code ?? '';
  return /database is locked|database table is locked/i.test(m) || /SQLITE_BUSY/i.test(code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Incrementally sync the vault into the store, retrying if another process
 * holds the write lock.
 *
 * `lore watch` makes concurrent indexing normal rather than exotic: the
 * watcher and a manual `lore index` will collide. SQLite's busy_timeout does
 * not cover a write-write conflict in WAL mode, which surfaced as a bare
 * "error: database is locked" and a non-zero exit.
 */
export async function indexVault(
  store: Store,
  root: string,
  opts: IndexOptions = {},
): Promise<IndexReport> {
  // Refused before the scan, and before any marker is set: on a read-only
  // index the first setMeta would fail anyway, after a full walk of the vault.
  store.assertWritable();
  const attempts = opts.lockRetries ?? 5;
  // Was an index already running in this process when we were called? If so, a
  // leftover own-PID marker is genuinely live, not stale. Captured before we
  // mark ourselves in flight so a fresh index after a crash sees `false`.
  const alreadyInFlight = indexInFlight;
  indexInFlight = true;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        // On a retry the marker is one WE set on the failed attempt, so it is
        // live too — do not let a transient lock force a needless full rebuild.
        return await indexVaultOnce(store, root, opts, alreadyInFlight || attempt > 0);
      } catch (err) {
        if (!isBusy(err) || attempt >= attempts) {
          if (isBusy(err)) {
            throw new Error(
              'another loreweave process is indexing this vault (is `lore watch` running?) — try again in a moment',
            );
          }
          throw err;
        }
        await sleep(120 * 2 ** attempt + Math.floor(attempt * 37)); // backoff
      }
    }
  } finally {
    // Only the outermost call clears the flag (guards nested indexVault calls).
    if (!alreadyInFlight) indexInFlight = false;
  }
}

async function indexVaultOnce(
  store: Store,
  root: string,
  opts: IndexOptions = {},
  ownMarkerLive = false,
): Promise<IndexReport> {
  const started = Date.now();
  const useNlp = opts.nlp !== false;
  const files = await scanVault(root, opts.ignore ?? [], {
    followExternal: opts.followExternalSymlinks,
  });

  // An index is many transactions, so a crash mid-run leaves derived state
  // (facts, mentions, importance) half-built with no way to notice: a later
  // incremental run sees matching mtimes and reports "+0 ~0 -0" forever.
  //
  // The marker records the PID that set it. A bare "1" could not distinguish
  // "a previous run crashed" from "another run is happening right now", so
  // two concurrent indexes each declared the other crashed and forced a
  // needless full rebuild.
  const marker = store.getMeta('index_in_progress');
  // An own-PID marker is "alive" only if an index is actually in flight (see
  // indexInFlight); otherwise it is the residue of a crashed run in this same
  // process and must be treated as interrupted. A foreign PID is resolved by
  // liveness. isRunning is never asked about our own PID because it would
  // always say yes.
  const interrupted =
    marker !== null &&
    marker !== '0' &&
    !(marker === String(process.pid) ? ownMarkerLive : isRunning(marker));
  const full = opts.full || interrupted;
  store.setMeta('index_in_progress', String(process.pid));

  const known = store.listNotes();
  const report: IndexReport = {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    warnings: [],
    durationMs: 0,
  };

  const seen = new Set<string>();
  for (const f of files) {
    seen.add(f.path);
    const prev = known.get(f.path);
    if (prev && !full && prev.mtimeMs === f.mtimeMs && prev.size === f.size) {
      report.unchanged++;
      continue;
    }
    let raw: string;
    try {
      const decoded = decodeNote(await readFile(f.absPath));
      raw = decoded.text;
      if (decoded.warning) report.warnings.push(`${f.path}: ${decoded.warning}`);
    } catch (err) {
      report.warnings.push(`${f.path}: unreadable (${(err as Error).message})`);
      continue;
    }
    if (prev && !full && prev.hash === sha1(raw)) {
      // touched but unchanged: record new mtime/size so next run short-circuits
      store.db
        .prepare(`UPDATE notes SET mtime_ms=?, size=? WHERE path=?`)
        .run(f.mtimeMs, f.size, f.path);
      report.unchanged++;
      continue;
    }
    const note = parseNote(f.path, raw, f.mtimeMs, f.size);
    // One transaction per note: a crash between the note write and its
    // mentions used to leave that note permanently mention-less, since the
    // next incremental run sees a matching hash and skips it.
    const tx = store.db.transaction(() => {
      store.upsertNote(note);
      writeMentions(store, note, useNlp);
    });
    tx();
    report.warnings.push(...note.warnings.map((w) => `${f.path}: ${w}`));
    if (prev) report.updated++;
    else report.added++;
  }

  for (const path of known.keys()) {
    if (!seen.has(path)) {
      store.deleteNote(path);
      report.removed++;
    }
  }
  if (report.removed > 0 || report.updated > 0) pruneOrphanEntities(store);
  if (report.added > 0 || report.updated > 0 || report.removed > 0) {
    rebuildFactsFromNotes(store, opts.factExtract ?? 'explicit');
    updateImportance(store);
  }

  store.setMeta('last_index_at', new Date().toISOString());
  // Only clear our own marker: a concurrent run may have replaced it.
  if (store.getMeta('index_in_progress') === String(process.pid)) {
    store.setMeta('index_in_progress', '0');
  }
  if (interrupted) {
    report.warnings.push(
      'previous index did not finish; performed a full rebuild to restore consistency',
    );
  }
  report.durationMs = Date.now() - started;
  return report;
}
