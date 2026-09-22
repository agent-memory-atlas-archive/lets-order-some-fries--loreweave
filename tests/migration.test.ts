import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MIGRATIONS, PARSER_VERSION } from '../src/store/schema.js';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { search } from '../src/retrieve/search.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';

/**
 * Every schema version that was ever published must still open.
 *
 * The index is a disposable cache, but people do not expect to delete it to
 * install an upgrade, and a migration that fails leaves them with a tool that
 * will not start. Verified by hand against real installs of 0.1.0, 0.2.0,
 * 0.3.0, 0.3.5 and 0.4.0 from npm; reproduced here without the network by
 * building each historical schema from the migration list itself, so a new
 * migration is checked against every old database automatically.
 */
async function makeVaultAtSchema(version: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `lw-mig-v${version}-`));
  await writeFile(
    join(root, 'alpha.md'),
    '# Alpha\n\nSee [[Beta]] and [a link](beta.md). Distinctive: PANGOLIN.\n\n- role:: Engineer\n',
  );
  await writeFile(
    join(root, 'beta.md'),
    '---\ntitle: Beta\ndate: 2025-04-01\n---\n\n# Beta\n\nBack to [[Alpha]].\n',
  );
  const dbFile = join(root, 'index.db');
  const db = new Database(dbFile);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (let i = 0; i < version; i++) {
    db.exec(MIGRATIONS[i]!.replace(/CREATE TABLE meta[^;]+;/, ''));
  }
  db.prepare(`INSERT INTO meta(key,value) VALUES('schema_version',?)`).run(String(version));
  db.close();
  return root;
}

describe('schema upgrades', () => {
  for (let v = 1; v <= MIGRATIONS.length; v++) {
    it(`a database written at schema v${v} opens, upgrades and still answers`, async () => {
      const root = await makeVaultAtSchema(v);
      const dbFile = join(root, 'index.db');

      const store = openStore(dbFile);
      const after = store.db
        .prepare(`SELECT value FROM meta WHERE key='schema_version'`)
        .get() as { value: string };
      expect(Number(after.value)).toBe(MIGRATIONS.length);

      // and it is not merely open — it indexes and answers
      await indexVault(store, root);
      const config = ConfigSchema.parse({});
      let cached: LoreGraph | null = null;
      const ctx: LoreContext = {
        root,
        config,
        store,
        provider: null,
        graph: () => (cached ??= buildGraph(store, config)),
        noteLinks: () => buildNoteLinkGraph(store),
        invalidateGraph: () => (cached = null),
        close: () => store.close(),
      };
      const hits = await search(ctx, 'PANGOLIN', { k: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.notePath).toBe('alpha.md');
      store.close();
    });
  }

  it('a migration that changes parse output invalidates what the old parser wrote', async () => {
    // Incremental indexing short-circuits on mtime AND size before it ever
    // consults the hash. A migration that clears only the hash therefore
    // changes nothing: the schema upgrades, the rows keep whatever the old
    // parser put there, and the bug looks fixed because it IS fixed on new
    // vaults. Measured — the upgrade reported "+0 ~0 -0 =3" until the size
    // went too. mtime_ms deliberately does NOT go: size = -1 already fails
    // the short-circuit, and the mtime is the note's modified-time, which
    // five read paths report to the user.
    const root = await makeVaultAtSchema(4);
    const dbFile = join(root, 'index.db');

    // populate it the way v4 would have, then upgrade
    const old = new Database(dbFile);
    old
      .prepare(
        `INSERT INTO notes(path,title,frontmatter,tags,hash,mtime_ms,size,indexed_at)
         VALUES ('alpha.md','Alpha','{}','[]','stale-hash',1,1,'2026-01-01')`,
      )
      .run();
    old.close();

    const store = openStore(dbFile);
    const row = store.db.prepare(`SELECT hash, mtime_ms, size FROM notes`).get() as {
      hash: string;
      mtime_ms: number;
      size: number;
    };
    expect(row.hash).toBe('');
    expect(row.size).toBe(-1);
    expect(row.mtime_ms).toBe(1);

    // so the next index actually reparses rather than reporting "unchanged"
    const report = await indexVault(store, root);
    expect(report.unchanged).toBe(0);
    store.close();
  });
});

/**
 * meta.schema_version is the only stamp with no guard in either direction.
 *
 * Its neighbours were both described as self-healing because they compare
 * with !==, so an older binary re-runs its own work and a later upgrade
 * re-runs the newer work. That was wrong for parser_version, whose branch
 * rewrites the stamp DOWN and wipes every fingerprint on the way: two builds
 * sharing one vault undid each other on every open. It now compares with `<`
 * (see 'parser stamp guards' below). note_gate_version still compares with
 * ===, and does alternate the same way, but its pass is a walk of the paths
 * already in the store with no fingerprint wipe and no reparse, so the cost
 * is a different order of magnitude and nobody has measured it hurting.
 * schema_version is compared with `<` by the migration loop alone, so
 * anything the loop cannot interpret is absorbed silently instead of
 * refused.
 */
describe('schema stamp guards', () => {
  async function stamp(value: string): Promise<string> {
    const root = await makeVaultAtSchema(MIGRATIONS.length);
    const dbFile = join(root, 'index.db');
    const db = new Database(dbFile);
    db.prepare(`UPDATE meta SET value=? WHERE key='schema_version'`).run(value);
    db.close();
    return dbFile;
  }

  it('refuses an index stamped by a newer loreweave instead of answering from it', async () => {
    // Measured before the guard: with schema_version=9 against 6 migrations
    // the loop simply did not run, and `search`, `doctor` and `stats` all
    // exited 0 without mentioning the version. With a plausible v7 applied by
    // hand (a column the newer schema uses to exclude a note) the v6 binary
    // returned the excluded note — answering from an index it does not
    // understand, which is the one thing this tool must not do.
    const dbFile = await stamp(String(MIGRATIONS.length + 3));
    expect(() => openStore(dbFile)).toThrow(/newer loreweave/);
  });

  it('treats a stamp that is not a version number as corrupt rather than writing back NaN', async () => {
    // Measured before the guard: 'six' -> Number() NaN -> the loop is skipped,
    // and because NaN !== NaN the stamp was rewritten as the literal string
    // 'NaN' — on every open, turning the migration system into a permanent
    // no-op and putting a write on the read path.
    const dbFile = await stamp('six');
    const healed: string[] = [];
    const store = openStore(dbFile, { onHeal: (m) => healed.push(m) });
    const after = store.db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {
      value: string;
    };
    expect(after.value).not.toBe('NaN');
    expect(Number(after.value)).toBe(MIGRATIONS.length);
    expect(healed.join(' ')).toMatch(/corrupt/);
    store.close();
  });

  it('an empty stamp is corrupt too, and does not re-run every migration', async () => {
    // Measured before the guard: '' -> Number() 0 -> all six migrations re-run
    // against tables that already exist -> "table notes already exists", raw
    // SQLite text, and the rollback leaves the bad stamp in place so every
    // future command fails the same way, forever.
    const dbFile = await stamp('');
    const healed: string[] = [];
    const store = openStore(dbFile, { onHeal: (m) => healed.push(m) });
    const after = store.db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {
      value: string;
    };
    expect(Number(after.value)).toBe(MIGRATIONS.length);
    expect(healed.join(' ')).toMatch(/corrupt/);
    store.close();
  });

  it('a current stamp still opens without a single write', async () => {
    // The stamp-only-when-changed optimisation at the end of migrate() is what
    // makes a read-only index readable at all; the NaN re-stamp defeated it.
    // Pinned as a property — zero row changes on the connection — rather than
    // by timing anything.
    const root = await makeVaultAtSchema(MIGRATIONS.length);
    const dbFile = join(root, 'index.db');
    openStore(dbFile).close(); // first open stamps parser_version
    const store = openStore(dbFile);
    const { c } = store.db.prepare(`SELECT total_changes() AS c`).get() as { c: number };
    expect(c).toBe(0);
    store.close();
  });
});

/**
 * The parser stamp has to hold in BOTH directions.
 *
 * Backwards it forces the reparse an upgrade needs (mtime-survives-stamp.test.ts
 * pins that half). Forwards it must do nothing: two installed builds on one
 * vault is the README's own setup — `npx -y loreweave` for the MCP server
 * always resolves to latest, `npm i -g loreweave` for the CLI stays where the
 * user left it — so an older binary that restamps DOWN makes every index a
 * full reparse, forever, in both builds.
 */
describe('parser stamp guards', () => {
  async function indexedVault(): Promise<string> {
    const root = await makeVaultAtSchema(MIGRATIONS.length);
    const dbFile = join(root, 'index.db');
    const store = openStore(dbFile);
    await indexVault(store, root);
    store.close();
    return dbFile;
  }

  function stampParser(dbFile: string, value: number): void {
    const raw = new Database(dbFile);
    raw
      .prepare(`INSERT INTO meta(key,value) VALUES('parser_version',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(String(value));
    raw.close();
  }

  it('leaves an index parsed by a newer build alone instead of reverting it', async () => {
    const dbFile = await indexedVault();
    stampParser(dbFile, PARSER_VERSION + 1);

    const store = openStore(dbFile);
    const stamp = store.db.prepare(`SELECT value FROM meta WHERE key='parser_version'`).get() as {
      value: string;
    };
    // the stamp is not dragged back down to this build's number …
    expect(Number(stamp.value)).toBe(PARSER_VERSION + 1);
    // … and the newer parser's work is not thrown away
    const rows = store.db.prepare(`SELECT path, hash, size FROM notes ORDER BY path`).all() as {
      path: string;
      hash: string;
      size: number;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.hash, r.path).not.toBe('');
      expect(r.size, r.path).toBeGreaterThan(0);
    }
    store.close();
  });

  it('does not turn every index into a full reparse when two builds share a vault', async () => {
    // Measured on a 2 000-note vault before the guard: a steady-state
    // incremental was 35 ms, and one read by the other binary made the next
    // index `+0 ~2000 -0 =0` at 2 001 ms — 57x, on every save, in both builds.
    const dbFile = await indexedVault();
    const root = dirname(dbFile);
    stampParser(dbFile, PARSER_VERSION + 1);

    const store = openStore(dbFile);
    const report = await indexVault(store, root);
    expect(report.updated).toBe(0);
    expect(report.unchanged).toBeGreaterThan(0);
    store.close();

    // and the stamp the newer build left is still there for it to find
    const after = openStore(dbFile);
    expect(Number(after.getMeta('parser_version'))).toBe(PARSER_VERSION + 1);
    after.close();
  });
});
