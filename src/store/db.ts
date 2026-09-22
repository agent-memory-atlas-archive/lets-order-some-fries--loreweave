import Database from 'better-sqlite3';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Note } from '../types.js';
import { MIGRATIONS, PARSER_VERSION } from './schema.js';

export interface LexicalHit {
  blockId: number;
  notePath: string;
  anchor: string;
  heading: string;
  snippet: string;
  /** bm25 rank; lower = better (SQLite convention), exposed negated as score. */
  score: number;
}

export interface Store {
  db: Database.Database;
  path: string;
  close(): void;
  /** Replace a note and all its derived rows atomically. Returns anchor→blockId. */
  upsertNote(note: Note): Map<string, number>;
  deleteNote(path: string): void;
  /** path → {hash, mtimeMs} for the incremental diff. */
  listNotes(): Map<string, { hash: string; mtimeMs: number; size: number }>;
  /** FTS5 search; AND semantics with OR fallback. Excludes archived blocks unless includeArchived. */
  searchLexical(query: string, k: number, includeArchived?: boolean): LexicalHit[];
  logAccess(kind: 'retrieved' | 'used', blockId: number | null, query?: string): void;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  /**
   * True when the index cannot be written — a read-only file, a directory
   * that forbids SQLite's -wal/-shm files, or the snapshot copy that case
   * falls back to. Read commands work; every write is refused with one line
   * naming the path (see assertWritable).
   */
  readonly readonly: boolean;
  /** Throw the read-only error if the index cannot be written. */
  assertWritable(): void;
}

export { normalizeKey } from '../normalize.js';
import { contentTerms, linkMatchKey, segmentCJK } from '../normalize.js';
import { extractDates, parseDateExpression } from '../temporal/dates.js';

/** A dated filename (2026-08-05-standup.md, journal/2026-08-05.md) dates the note. */
function filenameDate(path: string): { from: string; to: string } | null {
  const base = path.split('/').pop() ?? path;
  const m = base.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? parseDateExpression(m[1]!) : null;
}

/**
 * Upper bound on terms in one MATCH expression.
 *
 * Only a guard against pathological input, not a tuning knob: measured on a
 * 400-note vault, 512 OR-terms cost 4 ms, so the previous limit of 32 was
 * roughly an order of magnitude below anything the engine minds. It was low
 * enough to matter — a long question whose decisive word came 41st lost that
 * word entirely and returned a note matching only the preamble, which is the
 * shape of query an agent produces when it pastes context and puts the actual
 * ask at the end.
 */
const MAX_FTS_TERMS = 256;

/** Turn free text into a safe FTS5 MATCH expression (quoted tokens). */
export function ftsQuery(text: string, joiner: ' ' | ' OR '): string | null {
  // Content words only: with AND semantics, one stray "what" in the question
  // is enough to miss the block that literally answers it.
  //
  // Deduplicated, as the coverage path already does: a repeated word tells
  // FTS nothing it does not know from the first occurrence, and prose repeats
  // constantly — "the compaction strategy for compaction of the streaming
  // compaction pipeline" is seven terms and four distinct ones. Under a cap,
  // duplicates spend the budget on nothing.
  const tokens = [...new Set(contentTerms(segmentCJK(text)))].slice(0, MAX_FTS_TERMS);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(joiner);
}

/** Block the thread briefly; openStore is synchronous by design. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * SQLite's family of "cannot write" errors, whatever the precise cause
 * (SQLITE_READONLY, _DIRECTORY, _CANTINIT, ...). They all carry the same
 * message, "attempt to write a readonly database", which is what every
 * command used to die with — including the ones that only read.
 */
export function isReadonlyError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  const m = (err as Error)?.message ?? '';
  return code.startsWith('SQLITE_READONLY') || /readonly database/i.test(m);
}

/** The one line a write against a read-only index fails with. */
export function readonlyError(dbPath: string, why?: string): Error {
  return new Error(
    `the index is read-only: ${dbPath}${why ? ` (${why})` : ''} — make .lore/ and index.db writable to run commands that change the index`,
  );
}

function fileWritable(p: string): boolean {
  try {
    accessSync(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** True for the SQLite errors that mean "this file is not a usable index". */
function isCorruption(err: unknown): boolean {
  const m = (err as Error)?.message ?? '';
  return (
    /malformed|not a database|file is encrypted|database disk image/i.test(m) ||
    /SQLITE_CORRUPT|SQLITE_NOTADB/i.test((err as { code?: string })?.code ?? '')
  );
}

/**
 * Deep integrity check + repair. Deliberate, not automatic: it reads the
 * entire file. Returns true if the index was reset.
 */
export function verifyOrReset(dbPath: string, onHeal?: (m: string) => void): boolean {
  if (dbPath === ':memory:') return false;
  let corrupt = false;
  try {
    const probe = new Database(dbPath, { readonly: true });
    try {
      const res = probe.pragma('quick_check') as { quick_check: string }[];
      corrupt = res[0]?.quick_check !== 'ok';
    } finally {
      probe.close();
    }
  } catch (err) {
    if (!isCorruption(err)) return false; // locked/missing is not corruption
    corrupt = true;
  }
  if (!corrupt) return false;
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  onHeal?.(`index was corrupt and has been reset — re-run 'lore index' to rebuild`);
  return true;
}

export interface OpenStoreOptions {
  /**
   * Rebuild from scratch if the index file is corrupt. On by default: the
   * index is a derived cache and the vault is the source of truth, so a
   * damaged cache should heal rather than brick every command.
   */
  healCorruption?: boolean;
  onHeal?: (message: string) => void;
  /** Rows of retrieval history to keep (see config.accessLogRows). */
  accessLogRows?: number;
}

/** Inserts between retention checks; see logAccess. */
const TRIM_EVERY = 200;

export function openStore(dbPath: string, opts: OpenStoreOptions = {}): Store {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const heal = opts.healCorruption !== false && dbPath !== ':memory:';
  const accessLogRows = opts.accessLogRows ?? 5000;
  let sinceTrim = 0;

  // Read-only is a state, not an error. A vault on a read-only mount, a
  // `.lore/` owned by another account, a backup opened in place: every
  // command failed with SQLite's raw "attempt to write a readonly database",
  // including search, facts, stats and timeline, which only read. The
  // bookkeeping below (schema stamp, parser stamp, the access log) was what
  // wrote. Known up front when the file itself is not writable; otherwise
  // learned from the first write that fails, so no probe write is needed —
  // a probe would queue every read command behind a running indexer.
  let readonly = dbPath !== ':memory:' && existsSync(dbPath) && !fileWritable(dbPath);
  let snapshotDir: string | null = null;

  let db: Database.Database;
  try {
    db = new Database(dbPath);
    // Opening is lazy; force a read so corruption surfaces here rather than
    // as a raw SQLite error in the middle of an unrelated command.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (err) {
    if (heal && isCorruption(err)) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      opts.onHeal?.(`index was corrupt and has been reset — re-run 'lore index' to rebuild`);
      db = new Database(dbPath);
    } else if (
      dbPath !== ':memory:' &&
      (isReadonlyError(err) ||
        // With an un-checkpointed -wal beside it — a backup copied while the
        // engine was open, a .lore/ shared from another account — SQLite
        // cannot create the -shm it needs and reports CANTOPEN instead of
        // READONLY. Same situation, different code.
        ((err as { code?: string }).code === 'SQLITE_CANTOPEN' &&
          existsSync(dbPath) &&
          !fileWritable(dirname(dbPath))))
    ) {
      // A WAL-mode database needs a -shm file beside it even to READ, and
      // when the directory forbids creating one SQLite reports
      // SQLITE_READONLY_DIRECTORY on the first statement — the same message
      // as a failed write. Measured: `chmod 555 .lore` with no -shm left
      // behind made every command fail before reading a row. A snapshot in
      // a writable temp directory is a copy of a file nobody can change, so
      // reading it is reading the index; it is removed on close.
      snapshotDir = mkdtempSync(join(tmpdir(), 'loreweave-ro-'));
      const copy = join(snapshotDir, 'index.db');
      copyFileSync(dbPath, copy);
      if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${copy}-wal`);
      db = new Database(copy, { readonly: true });
      readonly = true;
    } else {
      throw err;
    }
  }
  // meta.schema_version is the only stamp with no guard in either direction,
  // and the migration loop below consults it with `<` alone — so any value the
  // loop cannot interpret is absorbed instead of refused. Measured at v6:
  // a stamp of '9' let every command run and answer normally (with a
  // hand-applied plausible v7, the old binary served the row the newer schema
  // had flagged); a stamp of 'six' became NaN, skipped the loop, and — since
  // NaN !== NaN — was written back as the literal string 'NaN' on every open,
  // permanently disabling migrations and putting a write on the read path;
  // a stamp of '' became 0 and re-ran all six migrations into "table notes
  // already exists", which the rollback then made permanent.
  //
  // Both checks are pure reads of one row, on the path of every command
  // including the pure readers, and they run before anything else touches the
  // file.
  {
    const hasMeta = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`)
      .get();
    const stamp = hasMeta
      ? (db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as
          | { value: string }
          | undefined)
      : undefined;
    if (stamp !== undefined) {
      if (!/^\s*\d+\s*$/.test(stamp.value)) {
        // The value carries no information, so there is nothing to migrate
        // from. Route it into the reset that already exists for a corrupt
        // file rather than throwing: the index is a derived cache.
        if (heal && snapshotDir === null && !readonly) {
          db.close();
          rmSync(dbPath, { force: true });
          rmSync(`${dbPath}-wal`, { force: true });
          rmSync(`${dbPath}-shm`, { force: true });
          opts.onHeal?.(`index was corrupt and has been reset — re-run 'lore index' to rebuild`);
          db = new Database(dbPath);
        } else {
          // Nothing to reset into: healing is off, or the file is read-only
          // and what we hold is a snapshot copy of it.
          throw new Error(
            `index schema stamp is not a version number (${JSON.stringify(stamp.value)}) — the index is corrupt; delete .lore/ and re-index`,
          );
        }
      } else if (Number(stamp.value) > MIGRATIONS.length) {
        // Deliberately a refusal and not a reset. The data is intact and
        // re-indexing a large vault is expensive, so deleting someone's index
        // because they ran an old binary once would be the wrong trade — and
        // the bound comes from MIGRATIONS.length, never a hand-kept constant,
        // so a build can always satisfy its own stamp.
        throw new Error(
          `index schema v${Number(stamp.value)} was written by a newer loreweave ` +
            `(this build knows v${MIGRATIONS.length}) — upgrade loreweave, or delete .lore/ and re-index`,
        );
      }
    }
  }

  // busy_timeout must be set first: `journal_mode = WAL` needs a brief
  // exclusive lock, so setting the timeout afterwards left the one pragma
  // most likely to collide with no timeout at all.
  db.pragma('busy_timeout = 10000');
  // Even with a timeout, switching journal mode returns SQLITE_BUSY
  // immediately when another connection is initialising the same new file —
  // busy_timeout does not cover that case. Retry briefly instead of failing
  // the whole command, which is what `lore watch` + a manual index hit.
  for (let attempt = 0; ; attempt++) {
    try {
      db.pragma('journal_mode = WAL');
      break;
    } catch (err) {
      if (isReadonlyError(err)) {
        readonly = true; // cannot switch modes; reads work in whichever it is
        break;
      }
      if (attempt >= 20 || !/locked|busy/i.test((err as Error).message)) throw err;
      sleepSync(25);
    }
  }
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  // NOTE: no full integrity scan here. `quick_check` reads the whole file,
  // so running it on every command was both slow and lock-prone — it made
  // concurrent commands fail with "database is locked". The cheap
  // sqlite_master probe above catches an unusable file; deep verification
  // belongs in `lore doctor`, which can heal deliberately.

  // migrations
  const migrate = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as
      | { value: string }
      | undefined;
    const stored = row ? Number(row.value) : 0;
    let version = stored;
    for (let i = version; i < MIGRATIONS.length; i++) {
      db.exec(MIGRATIONS[i]!.replace(/CREATE TABLE meta[^;]+;/, '')); // meta pre-created
      version = i + 1;
    }
    // Stamp only when something changed. Upserting unconditionally was a
    // write on every open of a current index, which is what made a
    // read-only index unusable for reading.
    if (version !== stored) {
      db.prepare(
        `INSERT INTO meta(key,value) VALUES('schema_version',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      ).run(String(version));
    }
  });
  try {
    migrate();
  } catch (err) {
    if (!isReadonlyError(err)) throw err;
    // The only write in there is a pending migration, and the code that
    // follows assumes the new schema — so this cannot be read either.
    throw readonlyError(dbPath, 'and its schema is older than this version');
  }

  // Parser-version check: see PARSER_VERSION. A vault indexed by an older
  // parser keeps stale titles and dates forever, because the incremental
  // indexer trusts mtime+size+hash. Clearing the fingerprints makes the next
  // index reparse the vault — the same healing migration v5 performed, but
  // driven by the parser's version rather than the schema's.
  //
  // hash and size only. mtime_ms is half the fingerprint but it is also the
  // only record of WHEN each note was modified, and five read paths consume
  // it as a timestamp — lore_context_pack's "recently modified" list,
  // lore_propose_facts' sample, the recency term in block importance, the
  // recorded_at a fact derived from a note carries, and resume. Clearing it
  // did not make the reparse any more certain (size = -1 already fails the
  // mtime-AND-size short-circuit, hash = '' fails the hash one) and it left
  // every note claiming to have been modified at 1969-12-31T23:59:59.999Z,
  // so an agent calling context_pack to orient itself was handed the vault's
  // ten OLDEST notes labelled as the recent ones. It happens once per user
  // per release, inside openStore, on a pure read, with nothing printed.
  const stampedParser = db.prepare(`SELECT value FROM meta WHERE key='parser_version'`).get() as
    | { value: string }
    | undefined;
  //
  // Strictly BELOW, never `!==`. The schema stamp took the same guard in
  // 0.37.x for the reason written beside it — re-indexing a large vault is
  // expensive, so discarding someone's index because they ran an old binary
  // once is the wrong trade — and it applies here with more force, because
  // this branch does not refuse, it silently rewrites the stamp DOWN. Two
  // builds against one vault is the README's own setup (`npx -y loreweave`
  // for the MCP server resolves to latest; `npm i -g loreweave` for the CLI
  // stays where the user left it), so `!==` made each build undo the other on
  // every open and turned every subsequent index into a full reparse in both.
  // A newer parser's output is at least as good as this build's; there is
  // nothing to gain by redoing it, and leaving the stamp alone is what stops
  // the alternation.
  //
  // A stamp that is not a number is not a claim to be newer — `NaN < n` is
  // false, which would strand it unhealed forever — so it counts as unparsed.
  const stampedParserNum = Number(stampedParser?.value ?? 0);
  if (!Number.isFinite(stampedParserNum) || stampedParserNum < PARSER_VERSION) {
    try {
      db.transaction(() => {
        db.exec(`UPDATE notes SET hash = '', size = -1`);
        db.prepare(
          `INSERT INTO meta(key,value) VALUES('parser_version',?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        ).run(String(PARSER_VERSION));
      })();
    } catch (err) {
      if (!isReadonlyError(err)) throw err;
      // Reads do not need the reparse; the next index does, and it will
      // find the stamp still mismatched once the file is writable again.
      readonly = true;
    }
  }

  const assertWritable = (): void => {
    if (readonly) throw readonlyError(dbPath);
  };
  /** Run a write; a read-only failure becomes the clear error and is remembered. */
  const guarded = <T>(fn: () => T): T => {
    assertWritable();
    try {
      return fn();
    } catch (err) {
      if (isReadonlyError(err)) {
        readonly = true;
        throw readonlyError(dbPath);
      }
      throw err;
    }
  };

  const stmts = {
    insNote: db.prepare(
      `INSERT INTO notes(path,title,frontmatter,tags,hash,mtime_ms,size,indexed_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET title=excluded.title, frontmatter=excluded.frontmatter,
         tags=excluded.tags, hash=excluded.hash, mtime_ms=excluded.mtime_ms,
         size=excluded.size, indexed_at=excluded.indexed_at`,
    ),
    delBlocks: db.prepare(`DELETE FROM blocks WHERE note_path=?`),
    delLinks: db.prepare(`DELETE FROM links WHERE note_path=?`),
    insBlock: db.prepare(
      `INSERT INTO blocks(note_path,anchor,heading,ord,text,hash,event_from,event_to,fts_text)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ),
    insLink: db.prepare(
      `INSERT INTO links(note_path,block_anchor,target,target_norm,heading,alias,style)
       VALUES (?,?,?,?,?,?,?)`,
    ),
    delNote: db.prepare(`DELETE FROM notes WHERE path=?`),
    listNotes: db.prepare(`SELECT path, hash, mtime_ms, size FROM notes`),
    getMeta: db.prepare(`SELECT value FROM meta WHERE key=?`),
    setMeta: db.prepare(
      `INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ),
    logAccess: db.prepare(`INSERT INTO access_log(at,kind,query,block_id) VALUES (?,?,?,?)`),
    countAccess: db.prepare(`SELECT COUNT(*) c FROM access_log`),
    trimAccess: db.prepare(
      `DELETE FROM access_log WHERE id NOT IN
         (SELECT id FROM access_log ORDER BY id DESC LIMIT ?)`,
    ),
  };

  const upsertNoteTx = db.transaction((note: Note): Map<string, number> => {
    stmts.insNote.run(
      note.path,
      note.title,
      JSON.stringify(note.frontmatter),
      JSON.stringify(note.tags),
      note.hash,
      note.mtimeMs,
      note.size,
      new Date().toISOString(),
    );
    // preserve dynamics for unchanged blocks: capture old state by hash
    const old = db
      .prepare(
        `SELECT id, anchor, hash, stability, last_accessed, access_count, importance
         FROM blocks WHERE note_path=? ORDER BY ord`,
      )
      .all(note.path) as {
      id: number;
      anchor: string;
      hash: string;
      stability: number;
      last_accessed: string | null;
      access_count: number;
      importance: number;
    }[];
    // Usage history is matched by anchor first, then by content.
    //
    // Hash alone is not an identity: a note can hold the same text twice — a
    // repeated disclaimer, a duplicated table row, boilerplate under two
    // headings — and a Map keyed by hash collapses them, so the last one wins
    // and BOTH blocks are restored from it. Measured, a note with two identical
    // sections lost all learned state on a reindex that changed nothing, which
    // is the one thing in the index that cannot be re-derived from the vault.
    //
    // Content still matters, and is the fallback rather than the key: renaming
    // a heading changes a block's anchor while leaving its text alone, and the
    // history should follow the text. Editing the text resets it, which is
    // correct — a retrieval history describes words that no longer exist.
    const oldByAnchor = new Map(old.map((o) => [o.anchor, o]));
    const oldByHash = new Map<string, typeof old>();
    for (const o of old) {
      const arr = oldByHash.get(o.hash);
      if (arr) arr.push(o);
      else oldByHash.set(o.hash, [o]);
    }
    const claimed = new Set<(typeof old)[number]>();
    const takePrev = (anchor: string, hash: string): (typeof old)[number] | undefined => {
      const exact = oldByAnchor.get(anchor);
      if (exact && exact.hash === hash && !claimed.has(exact)) {
        claimed.add(exact);
        return exact;
      }
      const queue = oldByHash.get(hash);
      const next = queue?.find((o) => !claimed.has(o));
      if (next) claimed.add(next);
      return next;
    };
    // access_log.block_id is ON DELETE SET NULL and every edit deletes ALL of
    // a note's blocks — so one edit erased that note's entire retrieval/use
    // history, including for blocks whose text never changed and whose
    // stability is carefully carried over a few lines below. fitDecay trains
    // on exactly those events, so the vaults someone actually works in trained
    // on the least data. Capture the log rows here; re-point them at the new
    // block ids under the same identity rule the carry-over uses.
    const logRowsByOldBlock = new Map<number, number[]>();
    for (const r of db
      .prepare(
        `SELECT id, block_id FROM access_log
         WHERE block_id IN (SELECT id FROM blocks WHERE note_path=?)`,
      )
      .all(note.path) as { id: number; block_id: number }[]) {
      const arr = logRowsByOldBlock.get(r.block_id);
      if (arr) arr.push(r.id);
      else logRowsByOldBlock.set(r.block_id, [r.id]);
    }
    stmts.delBlocks.run(note.path);
    stmts.delLinks.run(note.path);
    const ids = new Map<string, number>();
    // Content dates: the block's own prose date, else the note's
    // (frontmatter/filename). extractDates checks frontmatter FIRST and returns
    // on the first hit, so passing note.frontmatter here stamped EVERY block
    // with the single frontmatter date and ignored the dates written in the
    // block itself — a `--since/--until` window for an event dated in the prose
    // then dropped the very block that mentions it. Pass {} so block prose wins;
    // noteDates already carries the frontmatter/filename fallback.
    const noteDates = extractDates('', note.frontmatter) ?? filenameDate(note.path);
    for (const b of note.blocks) {
      const d = extractDates(b.text, {}) ?? noteDates;
      const info = stmts.insBlock.run(
        note.path,
        b.anchor,
        b.heading,
        b.order,
        b.text,
        b.hash,
        d?.from ?? null,
        d?.to ?? null,
        // heading breadcrumb is searchable too; CJK is split per character
        segmentCJK(`${b.heading.replace(/\//g, ' ')} ${b.text}`),
      );
      const id = Number(info.lastInsertRowid);
      ids.set(b.anchor, id);
      const prev = takePrev(b.anchor, b.hash);
      if (prev) {
        db.prepare(
          `UPDATE blocks SET stability=?, last_accessed=?, access_count=?, importance=? WHERE id=?`,
        ).run(prev.stability, prev.last_accessed, prev.access_count, prev.importance, id);
        const logIds = logRowsByOldBlock.get(prev.id);
        if (logIds?.length) {
          db.prepare(
            `UPDATE access_log SET block_id=? WHERE id IN (${logIds.map(() => '?').join(',')})`,
          ).run(id, ...logIds);
        }
      }
    }
    for (const l of note.links) {
      stmts.insLink.run(
        note.path,
        l.blockAnchor,
        l.target,
        linkMatchKey(note.path, l.target, l.style),
        l.heading ?? null,
        l.alias ?? null,
        l.style,
      );
    }
    return ids;
  });

  function searchLexical(query: string, k: number, includeArchived = false): LexicalHit[] {
    const run = (expr: string): LexicalHit[] =>
      db
        .prepare(
          `SELECT b.id AS blockId, b.note_path AS notePath, b.anchor, b.heading,
                  snippet(blocks_fts, 0, '', '', ' … ', 12) AS snippet,
                  bm25(blocks_fts) AS rank
           FROM blocks_fts
           JOIN blocks b ON b.id = blocks_fts.rowid
           WHERE blocks_fts MATCH ? ${includeArchived ? '' : 'AND b.archived = 0'}
           ORDER BY rank, b.note_path, b.anchor LIMIT ?`,
        )
        .all(expr, k)
        .map((r: any) => ({
          blockId: r.blockId,
          notePath: r.notePath,
          anchor: r.anchor,
          heading: r.heading,
          snippet: r.snippet,
          score: -r.rank, // bm25() is lower-is-better; negate so higher=better
        }));
    const andExpr = ftsQuery(query, ' ');
    if (!andExpr) return [];
    let hits = run(andExpr);
    if (hits.length === 0) {
      const orExpr = ftsQuery(query, ' OR ');
      if (orExpr && orExpr !== andExpr) hits = run(orExpr);
    }
    return hits;
  }

  return {
    db,
    path: dbPath,
    get readonly() {
      return readonly;
    },
    assertWritable,
    close: () => {
      db.close();
      if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
    },
    upsertNote: (n) => guarded(() => upsertNoteTx(n)),
    deleteNote: (p) => {
      guarded(() => stmts.delNote.run(p));
    },
    listNotes: () => {
      const m = new Map<string, { hash: string; mtimeMs: number; size: number }>();
      for (const r of stmts.listNotes.all() as {
        path: string;
        hash: string;
        mtime_ms: number;
        size: number;
      }[]) {
        m.set(r.path, { hash: r.hash, mtimeMs: r.mtime_ms, size: r.size });
      }
      return m;
    },
    searchLexical,
    logAccess: (kind, blockId, query) => {
      // Bookkeeping, not the answer: on a read-only index it is skipped, so
      // a search still returns its results.
      if (accessLogRows === 0 || readonly) return;
      try {
        stmts.logAccess.run(new Date().toISOString(), kind, query ?? null, blockId);
        // Trim on a margin rather than on every insert: the DELETE walks the
        // table, and paying that per search to remove one row would cost more
        // than the rows do.
        sinceTrim++;
        if (sinceTrim >= TRIM_EVERY) {
          sinceTrim = 0;
          const { c } = stmts.countAccess.get() as { c: number };
          if (c > accessLogRows) stmts.trimAccess.run(accessLogRows);
        }
      } catch (err) {
        if (!isReadonlyError(err)) throw err;
        readonly = true;
      }
    },
    getMeta: (k) => {
      const r = stmts.getMeta.get(k) as { value: string } | undefined;
      return r ? r.value : null;
    },
    setMeta: (k, v) => {
      guarded(() => stmts.setMeta.run(k, v));
    },
  };
}
