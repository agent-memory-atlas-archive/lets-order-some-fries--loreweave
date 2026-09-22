import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { buildGraph } from '../src/graph/build.js';
import { ppr } from '../src/graph/ppr.js';
import { ConfigSchema } from '../src/config.js';
import { FIXTURE_VAULT, makeVault } from './helpers.js';

const config = ConfigSchema.parse({});

describe('graph + ppr', () => {
  it('builds a connected graph from the fixture vault', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    const g = buildGraph(store, config);
    expect(g.blockCount).toBeGreaterThan(0);
    expect(g.entityCount).toBeGreaterThan(0);
    expect(g.offsets[g.n]).toBeGreaterThan(0); // has edges
    // entity node for amara osei exists
    expect(g.entityKeyIndex.has('amara osei')).toBe(true);
    store.close();
  });

  it('PPR from riverbed reaches glacier dataset through the bridge entity', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    const g = buildGraph(store, config);

    const seedEntity = g.entityKeyIndex.get('riverbed protocol')!;
    const scores = ppr(g, new Map([[seedEntity, 1]]), { alpha: 0.5, iterations: 4 });

    // block scores per note
    const noteScore = new Map<string, number>();
    const rows = store.db.prepare(`SELECT id, note_path FROM blocks`).all() as {
      id: number;
      note_path: string;
    }[];
    for (const r of rows) {
      const idx = g.blockIndex.get(r.id);
      if (idx === undefined) continue;
      noteScore.set(r.note_path, (noteScore.get(r.note_path) ?? 0) + scores[idx]!);
    }
    const glacier = noteScore.get('data/glacier-dataset.md') ?? 0;
    const unrelated = noteScore.get('notes/unrelated.md') ?? 0;
    expect(glacier).toBeGreaterThan(0);
    expect(glacier).toBeGreaterThan(unrelated);
    store.close();
  });

  it('empty seeds → zero scores; empty graph safe', async () => {
    const store = openStore(':memory:');
    const g = buildGraph(store, config);
    const scores = ppr(g, new Map());
    expect(scores.length).toBe(0);
    store.close();
  });
});

/**
 * The node ceiling is 2^21, because edge keys are packed two indices to a
 * number. A node is a block or an entity, and parse.ts counts a heading with
 * no body as a block — so four bytes of markdown buy one node, and an 8.4 MB
 * file of heading lines takes the whole vault past the ceiling. Indexing that
 * file succeeds; the throw fires later, on the retrieval path, where it is not
 * caught.
 *
 * The real reproduction takes 92 s to index, so the ceiling is injected here.
 * What is being pinned is not the limit but the explanation: a vault-wide
 * failure has to name the note that caused it.
 */
describe('the graph node ceiling', () => {
  it('names the note that blew it, and how to get the vault working again', async () => {
    const root = await makeVault({
      'generated/dump.md': '# a\n# b\n# c\n# d\n# e\n# f\n# g\n# h\n',
      'quokkas.md': '# Quokkas\n\nA regular note about quokkas.\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);
    let err: Error | null = null;
    try {
      buildGraph(store, config, { nodeLimit: 4 });
    } catch (e) {
      err = e as Error;
    }
    expect(err, 'the ceiling must still be enforced').not.toBeNull();
    const msg = err!.message;
    // the note, so the user knows which file to deal with …
    expect(msg).toContain('generated/dump.md');
    // … and the step that gets search working again
    expect(msg).toMatch(/ignore/);
    // the innocent note is not blamed
    expect(msg).not.toContain('quokkas.md');
    store.close();
  });

  it('is not in the way of an ordinary vault', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    expect(() => buildGraph(store, config)).not.toThrow();
    store.close();
  });
});

