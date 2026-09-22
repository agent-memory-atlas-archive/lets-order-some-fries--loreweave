/**
 * Versioned schema. Each entry runs once, in order, inside a transaction;
 * meta.schema_version records progress. NEVER edit an existing migration —
 * append a new one.
 */
/**
 * What the PARSER records, versioned separately from the schema.
 *
 * Migrations cover shape changes; this covers meaning changes. The indexer
 * skips a file whose mtime, size and hash all match, so a release that
 * teaches the parser something new (0.20.0: prose dates like "June 2023";
 * 0.24.0: H1 headings as titles) left every untouched note carrying what the
 * OLD parser recorded — and two identical vaults returned different answers
 * depending on which versions had indexed them, which the disposable-cache
 * promise forbids. Bump this whenever parseNote/extractDates output changes;
 * openStore then clears note fingerprints (migration v5's move) so the next
 * incremental run reparses everything.
 *
 * v4: also the lever when what is DERIVED from a parse changes, not only
 * parseNote's own output. Extracted facts dropped every `{valid_until=…}`, so
 * indexes built before this hold bounded facts stored open-ended. Those rows
 * are rewritten by rebuildFactsFromNotes, which only runs when an index sees
 * at least one added/updated/removed note — so without the bump an untouched
 * vault would keep answering with expired facts until something unrelated was
 * edited. Clearing the fingerprints makes every note count as updated once,
 * which is exactly the trigger that pass needs. Since 0.37.x the clear leaves
 * mtime_ms alone, so this costs one reparse and destroys nothing.
 */
export const PARSER_VERSION = 4;

/**
 * What counts as a NOTE, versioned so a change to the definition repairs the
 * indexes earlier versions built under the old one.
 *
 * Bumping PARSER_VERSION only clears fingerprints, which makes the next index
 * REPARSE files the scan still yields — it can never remove a row for a file
 * the scan no longer yields at all. 0.37.0 narrowed the definition (a symlink
 * named *.md whose target is not a note, hidden and ignored directories,
 * derived prefixes), so every index built before it carries rows the engine
 * would now refuse to create, and the incremental indexer never revisits them.
 * For the symlink case those rows hold the contents of whatever the link
 * pointed at. Bump this whenever whyNotNote's answer changes for any path.
 *
 * v2: a note whose real file lives outside the vault is no longer a note
 * unless config.followExternalSymlinks says so, so every index built before
 * that carries rows holding out-of-vault file contents. Dropping those rows
 * on the first read after the upgrade is what this bump is for.
 */
export const NOTE_GATE_VERSION = 2;

export const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE notes (
    path        TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    frontmatter TEXT NOT NULL DEFAULT '{}',
    tags        TEXT NOT NULL DEFAULT '[]',
    hash        TEXT NOT NULL,
    mtime_ms    REAL NOT NULL,
    indexed_at  TEXT NOT NULL
  );

  CREATE TABLE blocks (
    id           INTEGER PRIMARY KEY,
    note_path    TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    anchor       TEXT NOT NULL,
    heading      TEXT NOT NULL DEFAULT '',
    ord          INTEGER NOT NULL,
    text         TEXT NOT NULL,
    hash         TEXT NOT NULL,
    stability    REAL NOT NULL DEFAULT 1.0,
    last_accessed TEXT,
    access_count INTEGER NOT NULL DEFAULT 0,
    importance   REAL NOT NULL DEFAULT 0.3,
    archived     INTEGER NOT NULL DEFAULT 0,
    UNIQUE(note_path, anchor)
  );
  CREATE INDEX idx_blocks_note ON blocks(note_path);

  -- Standalone (not external-content) so the indexed text can include the
  -- heading breadcrumb: a query matching only a heading must still find the
  -- section. Duplication is negligible at personal-vault scale.
  CREATE VIRTUAL TABLE blocks_fts USING fts5(
    text,
    tokenize='porter unicode61'
  );
  CREATE TRIGGER blocks_ai AFTER INSERT ON blocks BEGIN
    INSERT INTO blocks_fts(rowid, text)
      VALUES (new.id, replace(new.heading, '/', ' ') || ' ' || new.text);
  END;
  CREATE TRIGGER blocks_ad AFTER DELETE ON blocks BEGIN
    DELETE FROM blocks_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER blocks_au AFTER UPDATE OF text, heading ON blocks BEGIN
    DELETE FROM blocks_fts WHERE rowid = old.id;
    INSERT INTO blocks_fts(rowid, text)
      VALUES (new.id, replace(new.heading, '/', ' ') || ' ' || new.text);
  END;

  CREATE TABLE links (
    id           INTEGER PRIMARY KEY,
    note_path    TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    block_anchor TEXT NOT NULL,
    target       TEXT NOT NULL,
    target_norm  TEXT NOT NULL,
    heading      TEXT,
    alias        TEXT
  );
  CREATE INDEX idx_links_note ON links(note_path);
  CREATE INDEX idx_links_target ON links(target_norm);

  CREATE TABLE entities (
    id      INTEGER PRIMARY KEY,
    key     TEXT NOT NULL UNIQUE,
    display TEXT NOT NULL
  );

  CREATE TABLE mentions (
    id           INTEGER PRIMARY KEY,
    entity_id    INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    note_path    TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    block_anchor TEXT NOT NULL,
    source       TEXT NOT NULL,
    confidence   REAL NOT NULL
  );
  CREATE INDEX idx_mentions_entity ON mentions(entity_id);
  CREATE INDEX idx_mentions_note ON mentions(note_path);

  CREATE TABLE edges (
    src_type TEXT NOT NULL,
    src_id   INTEGER NOT NULL,
    dst_type TEXT NOT NULL,
    dst_id   INTEGER NOT NULL,
    type     TEXT NOT NULL,
    weight   REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (src_type, src_id, dst_type, dst_id, type)
  ) WITHOUT ROWID;

  CREATE TABLE facts (
    id              INTEGER PRIMARY KEY,
    subject         TEXT NOT NULL,
    predicate       TEXT NOT NULL,
    object          TEXT NOT NULL,
    subject_display TEXT NOT NULL,
    valid_from      TEXT,
    valid_until     TEXT,
    recorded_at     TEXT NOT NULL,
    superseded_at   TEXT,
    superseded_by   INTEGER REFERENCES facts(id),
    source_type     TEXT NOT NULL DEFAULT 'stated',
    note_path       TEXT,
    block_anchor    TEXT,
    confidence      REAL NOT NULL DEFAULT 0.9
  );
  CREATE INDEX idx_facts_slot ON facts(subject, predicate);

  CREATE TABLE fact_links (
    src_fact INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    dst_fact INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    type     TEXT NOT NULL,
    PRIMARY KEY (src_fact, dst_fact, type)
  ) WITHOUT ROWID;

  CREATE TABLE embeddings (
    block_id INTEGER PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    dims     INTEGER NOT NULL,
    vec      BLOB NOT NULL,
    hash     TEXT NOT NULL
  );

  CREATE TABLE access_log (
    id       INTEGER PRIMARY KEY,
    at       TEXT NOT NULL,
    kind     TEXT NOT NULL,
    query    TEXT,
    block_id INTEGER REFERENCES blocks(id) ON DELETE SET NULL
  );
  `,
  // v2 — file size, so a content change that preserves mtime (cp -p, rsync -a,
  // tar -x, snapshot restore) is still detected.
  `
  ALTER TABLE notes ADD COLUMN size INTEGER NOT NULL DEFAULT -1;
  `,
  // v3 — content time: when a block is ABOUT, distinct from when the file was
  // last touched. `--since` previously filtered on mtime, so it answered
  // "recently edited" when the user asked "what happened in March".
  `
  ALTER TABLE blocks ADD COLUMN event_from TEXT;
  ALTER TABLE blocks ADD COLUMN event_to TEXT;
  CREATE INDEX idx_blocks_event ON blocks(event_from, event_to);
  `,
  // v4 — the exact text handed to FTS. CJK needs per-character segmentation,
  // which cannot be expressed in the trigger's SQL, so it is computed in JS
  // and stored. Rebuilds the FTS triggers to index this column.
  `
  ALTER TABLE blocks ADD COLUMN fts_text TEXT NOT NULL DEFAULT '';
  DROP TRIGGER IF EXISTS blocks_ai;
  DROP TRIGGER IF EXISTS blocks_ad;
  DROP TRIGGER IF EXISTS blocks_au;
  CREATE TRIGGER blocks_ai AFTER INSERT ON blocks BEGIN
    INSERT INTO blocks_fts(rowid, text) VALUES (new.id, new.fts_text);
  END;
  CREATE TRIGGER blocks_ad AFTER DELETE ON blocks BEGIN
    DELETE FROM blocks_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER blocks_au AFTER UPDATE OF fts_text ON blocks BEGIN
    DELETE FROM blocks_fts WHERE rowid = old.id;
    INSERT INTO blocks_fts(rowid, text) VALUES (new.id, new.fts_text);
  END;
  `,
  // v5 — how a link was written. The parser already distinguishes a
  // `[[wiki link]]` from a `[markdown](one.md)` and the distinction was
  // discarded on the way in, so `doctor` rendered every broken link as
  // `[[target]]` — including ones the file spells `](target)`. A report whose
  // whole purpose is "go fix this line" must quote the line as written, or the
  // reader greps for text that is not there.
  //
  // The next index must reparse, or existing rows keep the column default and
  // the schema is upgraded while the data still is not. Incremental indexing
  // short-circuits on mtime AND size before it ever looks at the hash, so
  // clearing the hash alone changes nothing — but size alone is enough, and
  // mtime_ms is NOT ours to clear: it is also the only record of when each
  // note was modified. See the note on the same statement in db.ts.
  //
  // A migration that changes what the parser records has to invalidate what
  // the old parser recorded. This is what "the index is a disposable cache"
  // is for.
  `
  ALTER TABLE links ADD COLUMN style TEXT NOT NULL DEFAULT 'wiki';
  UPDATE notes SET hash = '', size = -1;
  `,
  // v6 — the close date a PERSON set, kept apart from the one supersession
  // computes.
  //
  // `recomputeSupersessions` rebuilds the chain from scratch but could not
  // rebuild `valid_until`: it reset superseded_by and then closed with
  // COALESCE(valid_until, ?), so any close date already present survived
  // forever. Assertions arriving out of valid-time order therefore kept a
  // stale close and left two facts valid at the same instant — measured on 300
  // random histories, 127 of them ended with overlapping or inverted
  // intervals. Clearing valid_until wholesale would instead have discarded
  // `invalidate` and explicit --valid-until, which are user intent.
  //
  // With the two separated, the recompute owns the computed close and always
  // defers to the user's.
  `
  ALTER TABLE facts ADD COLUMN user_valid_until TEXT;
  UPDATE facts SET user_valid_until = valid_until
    WHERE valid_until IS NOT NULL AND superseded_by IS NULL;
  UPDATE notes SET hash = '', size = -1;
  `,
];
