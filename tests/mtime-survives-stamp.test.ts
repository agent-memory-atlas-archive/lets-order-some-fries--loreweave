import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { openStore } from '../src/store/db.js';
import { PARSER_VERSION } from '../src/store/schema.js';
import { indexVault } from '../src/index/indexer.js';
import { makeVault } from './helpers.js';

/**
 * notes.mtime_ms is two things at once: half of the incremental indexer's
 * fingerprint, and the only record loreweave keeps of when a note was last
 * modified. The fingerprint wipe that a parser or schema bump performs treats
 * it as only the first, so an upgrade erases the second — and `lore_context_pack`,
 * documented as the call an agent makes once to orient itself, then reports
 * the vault's OLDEST notes as its most recently modified ones.
 */
const ANCIENT = Date.UTC(2020, 0, 1);
const MIDDLE = Date.UTC(2024, 5, 15);
const RECENT = Date.UTC(2026, 8, 20);

async function vault(): Promise<string> {
  const root = await makeVault({
    'ancient.md': '# Ancient\n\nA note about the pangolin census of 2020.\n',
    'middle.md': '# Middle\n\nA note about the quokka survey.\n',
    'recent.md': '# Recent\n\nThis month: the kestrel migration.\n',
  });
  for (const [rel, ms] of [
    ['ancient.md', ANCIENT],
    ['middle.md', MIDDLE],
    ['recent.md', RECENT],
  ] as const) {
    await utimes(join(root, rel), new Date(ms), new Date(ms));
  }
  return root;
}

describe('a version stamp bump and note mtimes', () => {
  it('leaves each note its modified-time, so recency still reads as recency', async () => {
    const root = await vault();
    const dbFile = join(root, 'index.db');
    const store = openStore(dbFile);
    await indexVault(store, root);
    const order = () =>
      (store2 ?? store).db
        .prepare(`SELECT path, mtime_ms FROM notes ORDER BY mtime_ms DESC`)
        .all() as { path: string; mtime_ms: number }[];
    let store2: ReturnType<typeof openStore> | null = null;
    expect(order().map((r) => r.path)).toEqual(['recent.md', 'middle.md', 'ancient.md']);
    store.close();

    // the index was written by the previous parser — exactly what every user
    // has on disk the first time they run a new release
    const raw = new Database(dbFile);
    raw
      .prepare(`INSERT INTO meta(key,value) VALUES('parser_version',?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(String(PARSER_VERSION - 1));
    raw.close();

    store2 = openStore(dbFile);
    expect(order().map((r) => r.path)).toEqual(['recent.md', 'middle.md', 'ancient.md']);
    expect(order().find((r) => r.path === 'ancient.md')!.mtime_ms).toBe(ANCIENT);

    // and the reparse the bump exists to force still happens
    const fp = store2.db.prepare(`SELECT hash, size FROM notes WHERE path='recent.md'`).get() as {
      hash: string;
      size: number;
    };
    expect(fp.hash).toBe('');
    expect(fp.size).toBe(-1);
    const report = await indexVault(store2, root);
    expect(report.unchanged).toBe(0);
    expect(report.updated).toBe(3);
    store2.close();
  });
});
