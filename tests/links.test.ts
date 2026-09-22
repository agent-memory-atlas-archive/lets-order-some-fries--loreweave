import { describe, expect, it } from 'vitest';
import type { Store } from '../src/store/db.js';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import {
  buildNameIndex,
  buildNameResolver,
  buildNoteLinkGraph,
  resolveNoteName,
} from '../src/retrieve/expand.js';
import { makeVault } from './helpers.js';
import { openStore } from '../src/store/db.js';
import { parseNote } from '../src/vault/parse.js';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { parseNote } from '../src/vault/parse.js';
import { linkMatchKey, resolveRelative } from '../src/normalize.js';
import { makeVault } from './helpers.js';

describe('markdown link parsing', () => {
  it('parses relative .md links as note links', () => {
    const n = parseNote(
      'notes/a.md',
      'See [the design](../docs/design.md) and [sibling](./b.md) and [deep](sub/c.md#Section).\n',
      1,
    );
    const md = n.links.filter((l) => l.style === 'markdown');
    expect(md).toHaveLength(3);
    expect(md[0]).toMatchObject({ target: '../docs/design.md', alias: 'the design' });
    expect(md[1]!.target).toBe('b.md');
    expect(md[2]).toMatchObject({ target: 'sub/c.md', heading: 'Section' });
  });

  it('ignores external, image, anchor and non-md links', () => {
    const n = parseNote(
      'a.md',
      `[web](https://example.com) [mail](mailto:x@y.z) ![img](pic.png) [anchor](#top) [pdf](file.pdf)\n`,
      1,
    );
    expect(n.links.filter((l) => l.style === 'markdown')).toHaveLength(0);
  });

  it('ignores links inside code fences and inline code', () => {
    const n = parseNote(
      'a.md',
      'Text\n\n```sh\n[[not a link]] and [x](y.md)\n```\n\nInline `[[also not]]` here.\n\nReal [[Target]].\n',
      1,
    );
    expect(n.links.map((l) => l.target)).toEqual(['Target']);
  });

  it('decodes percent-encoded targets', () => {
    const n = parseNote('a.md', '[x](my%20note.md)\n', 1);
    expect(n.links[0]!.target).toBe('my note.md');
  });

  it('resolveRelative handles ./ ../ and refuses vault escapes', () => {
    expect(resolveRelative('notes/deep/a.md', '../b.md')).toBe('notes/b.md');
    expect(resolveRelative('notes/a.md', './b.md')).toBe('notes/b.md');
    expect(resolveRelative('a.md', '../../etc/passwd.md')).toBeNull();
  });

  it('both link styles resolve to the same match key', () => {
    expect(linkMatchKey('notes/a.md', '../people/Amara Osei.md', 'markdown')).toBe('amara osei');
    expect(linkMatchKey('notes/a.md', 'Amara Osei', 'wiki')).toBe('amara osei');
  });
});

describe('markdown links build real graph edges', () => {
  it('a markdown-linked vault gets links, in-degree importance and no false orphans', async () => {
    const root = await makeVault({
      'index.md': '# Index\n\nSee [Alpha](projects/alpha.md) and [Beta](projects/beta.md).\n',
      'projects/alpha.md': '---\ntitle: Alpha\n---\n\nAlpha depends on [Beta](./beta.md).\n',
      'projects/beta.md': '---\ntitle: Beta\n---\n\nBeta stands alone.\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);

    const links = store.db.prepare(`SELECT note_path, target_norm FROM links`).all() as {
      note_path: string;
      target_norm: string;
    }[];
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.target_norm).sort()).toEqual(['alpha', 'beta', 'beta']);

    // beta is linked twice → higher importance than the unlinked index note
    const imp = (p: string) =>
      (store.db.prepare(`SELECT importance i FROM blocks WHERE note_path=?`).get(p) as any).i;
    expect(imp('projects/beta.md')).toBeGreaterThan(imp('index.md'));

    store.close();
  });
});

describe('how a link was written is remembered', () => {
  it('persists wiki vs markdown style', async () => {
    // The parser has always distinguished them and the store discarded it, so
    // `doctor` rendered every broken link as `[[target]]` — including ones the
    // file spells `](target)`, sending the reader grepping for text that is
    // not in their vault.
    const store = openStore(':memory:');
    store.upsertNote(
      parseNote('a.md', '# A\n\nSee [[Beta]] and [also this](sub/real.md).\n', 1),
    );
    const rows = store.db
      .prepare(`SELECT target, style FROM links ORDER BY style`)
      .all() as { target: string; style: string }[];
    expect(rows).toEqual([
      { target: 'sub/real.md', style: 'markdown' },
      { target: 'Beta', style: 'wiki' },
    ]);
    store.close();
  });
});

describe('schema migration v5', () => {
  it('forces a reparse so existing rows do not keep the column default', async () => {
    // Incremental indexing short-circuits on mtime AND size before it ever
    // looks at the hash, so a migration that clears only the hash changes
    // nothing — the schema upgrades and the data does not. Clearing the size
    // is what breaks that short-circuit; the mtime must survive, because it
    // is also the note's modified-time and the read paths report it as one.
    const { MIGRATIONS } = await import('../src/store/schema.js');
    const v5 = MIGRATIONS[4] ?? '';
    expect(v5).toContain('style');
    expect(v5).toMatch(/hash\s*=\s*''/);
    expect(v5).toMatch(/size\s*=\s*-1/);
    expect(v5).not.toMatch(/mtime_ms/);
  });

  it('an index written before the column still opens and upgrades', async () => {
    const store = openStore(':memory:');
    store.upsertNote(parseNote('a.md', '# A\n\n[md](b.md) and [[Wiki]]\n', 1));
    const version = store.db
      .prepare(`SELECT value FROM meta WHERE key='schema_version'`)
      .get() as { value: string };
    expect(Number(version.value)).toBeGreaterThanOrEqual(5);
    const cols = (store.db.prepare(`PRAGMA table_info(links)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('style');
    store.close();
  });
});

describe('an ambiguous link resolves to the nearest note', () => {
  // Two projects each with an overview, or two notes both titled "Notes", is
  // the ordinary shape of a vault with per-topic folders. The name index held
  // one path per name, so the last note enumerated won and BOTH links pointed
  // at it — a `[[Overview]]` written inside projects/atlas/ could resolve to
  // projects/northwind/, silently.
  const VAULT = {
    'projects/atlas/overview.md':
      '---\ntitle: Overview\n---\n\n# Overview\n\nAtlas ingests telemetry through a streaming compactor.\n',
    'projects/northwind/overview.md':
      '---\ntitle: Overview\n---\n\n# Overview\n\nNorthwind reconciles invoices against the ledger.\n',
    'projects/atlas/plan.md': '# Atlas Plan\n\nDesign is in [[Overview]] — see the compactor.\n',
    'projects/northwind/plan.md': '# Northwind Plan\n\nBilling rules live in [[Overview]].\n',
  };

  it('links inside a folder point at that folder’s note', async () => {
    const root = await makeVault(VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    const graph = buildNoteLinkGraph(store);
    expect(graph.out.get('projects/atlas/plan.md')).toEqual(['projects/atlas/overview.md']);
    expect(graph.out.get('projects/northwind/plan.md')).toEqual([
      'projects/northwind/overview.md',
    ]);
    store.close();
  });

  it('an unambiguous name is unaffected', async () => {
    const root = await makeVault({
      'a.md': '# A\n\nSee [[Unique Target]].\n',
      'deep/nested/unique-target.md': '---\ntitle: Unique Target\n---\n\n# Unique Target\n\nBody.\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);
    expect(buildNoteLinkGraph(store).out.get('a.md')).toEqual([
      'deep/nested/unique-target.md',
    ]);
    store.close();
  });

  it('backlink credit goes to the nearest note too', async () => {
    // updateImportance resolved names its own way, so one note collected the
    // other's backlinks and the in-degree boost landed on the wrong project.
    const root = await makeVault(VAULT);
    const store = openStore(':memory:');
    await indexVault(store, root);
    const graph = buildNoteLinkGraph(store);
    expect(graph.in.get('projects/atlas/overview.md')).toEqual(['projects/atlas/plan.md']);
    expect(graph.in.get('projects/northwind/overview.md')).toEqual([
      'projects/northwind/plan.md',
    ]);
    store.close();
  });
});

describe('the name resolver agrees with the rule it replaces', () => {
  // resolveNoteName used to rescan every candidate for every link, which is
  // quadratic in the size of a colliding bucket — and the names that collide
  // are exactly the ones a whole vault links to (README.md, index.md). The
  // prefix map that replaced the scan has to give the SAME answer, including
  // the tie-break, or link expansion quietly walks to different notes.
  const bruteForce = (arr: string[], from: string): string => {
    const fromDirs = from.split('/').slice(0, -1);
    let best = arr[0]!;
    let bestShared = -1;
    for (const path of arr) {
      const dirs = path.split('/').slice(0, -1);
      let shared = 0;
      while (shared < dirs.length && shared < fromDirs.length && dirs[shared] === fromDirs[shared]) {
        shared++;
      }
      if (shared > bestShared) {
        bestShared = shared;
        best = path;
      }
    }
    return best;
  };

  it('matches brute force on hand-picked shapes', () => {
    const shapes: string[][] = [
      ['README.md', 'a/README.md', 'a/b/README.md', 'a/b/c/README.md'],
      ['a/b/x.md', 'a/c/x.md', 'd/x.md'],
      ['z/y/n.md', 'a/n.md'],
      ['a/b/n.md', 'a/b/c/n.md'],
    ];
    const froms = [
      'a/b/c/deep.md',
      'a/b/other.md',
      'a/solo.md',
      'root.md',
      'd/e/f/g.md',
      'z/y/sibling.md',
    ];
    for (const paths of shapes) {
      const sorted = [...paths].sort();
      const candidates = new Map([['n', sorted]]);
      const resolver = buildNameResolver(candidates);
      for (const from of froms) {
        expect(resolveNoteName(candidates, 'n', from, resolver)).toBe(bruteForce(sorted, from));
      }
    }
  });

  it('matches brute force on randomized vault shapes', () => {
    let seed = 20260922;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const segs = ['a', 'b', 'c', 'd', 'e'];
    const randPath = () => {
      const depth = rnd(4);
      const dirs: string[] = [];
      for (let i = 0; i < depth; i++) dirs.push(segs[rnd(segs.length)]!);
      return [...dirs, 'README.md'].join('/');
    };
    for (let trial = 0; trial < 300; trial++) {
      const paths = [...new Set(Array.from({ length: 2 + rnd(8) }, randPath))].sort();
      if (paths.length < 2) continue;
      const candidates = new Map([['readme', paths]]);
      const resolver = buildNameResolver(candidates);
      for (let q = 0; q < 8; q++) {
        const from = randPath().replace(/README\.md$/, 'note.md');
        expect(resolveNoteName(candidates, 'readme', from, resolver)).toBe(
          bruteForce(paths, from),
        );
      }
    }
  });

  it('a name only one note answers to never enters the resolver', () => {
    const candidates = new Map([
      ['solo', ['x/solo.md']],
      ['readme', ['x/README.md', 'y/README.md']],
    ]);
    const resolver = buildNameResolver(candidates);
    expect(resolver.has('solo')).toBe(false);
    expect(resolveNoteName(candidates, 'solo', 'q/w.md', resolver)).toBe('x/solo.md');
    expect(resolveNoteName(candidates, 'nothing', 'q/w.md', resolver)).toBeUndefined();
  });

  it('buildNameIndex still de-duplicates a note that answers to one name twice', () => {
    const idx = buildNameIndex([
      { path: 'README.md', title: 'readme' },
      { path: 'docs/README.md', title: 'docs' },
    ]);
    expect(idx.get('readme')).toEqual(['README.md', 'docs/README.md']);
  });
});

describe('the link graph does not rescan a colliding name once per link', () => {
  // The equivalence tests above all hand `resolveNoteName` a resolver, so they
  // stay green even if `buildNoteLinkGraph` stops building one — which is the
  // whole defect: a vault with one README.md per folder made the graph cost
  // O(links x bucket), 10s on a 20,000-note handbook, paid on every search.
  //
  // Wall clock is flaky on shared hardware, so this counts the work instead.
  // Every candidate the old scan looked at cost one `path.split('/')`, so the
  // number of splits charged while building the graph is an exact, machine-
  // independent stand-in for that scan, and the property to pin is that the
  // MARGINAL cost of one more link does not grow with the size of the bucket.
  const fakeStore = (
    notes: { path: string; title: string }[],
    links: { note_path: string; target_norm: string }[],
  ) =>
    ({
      db: {
        prepare: (sql: string) => ({
          all: () => (sql.includes('FROM notes') ? notes : links),
        }),
      },
    }) as unknown as Store;

  /** Splits charged to build the graph of a vault with `bucket` READMEs and `links` linkers. */
  const splits = (bucket: number, links: number): number => {
    const notes: { path: string; title: string }[] = [];
    // `bucket` notes that all answer to the name "readme"...
    for (let i = 0; i < bucket; i++) {
      notes.push({ path: `docs/s${i}/README.md`, title: `section ${i}` });
    }
    // ...and notes linking to it, the ordinary [readme](./README.md) shape.
    const rows: { note_path: string; target_norm: string }[] = [];
    for (let i = 0; i < links; i++) {
      const path = `docs/s0/note-${i}.md`;
      notes.push({ path, title: `note ${i}` });
      rows.push({ note_path: path, target_norm: 'readme' });
    }
    const store = fakeStore(notes, rows);
    const proto = String.prototype as unknown as { split: (...args: unknown[]) => unknown };
    const real = proto.split;
    let n = 0;
    proto.split = function (this: string, ...args: unknown[]) {
      n++;
      return real.apply(this, args);
    };
    try {
      buildNoteLinkGraph(store);
    } finally {
      proto.split = real;
    }
    return n;
  };

  /** Extra work per extra link, holding the vault's shape fixed. */
  const perLink = (bucket: number): number => (splits(bucket, 45) - splits(bucket, 5)) / 40;

  it('costs the same per link whether 250 or 1000 notes share the name', () => {
    const small = perLink(250);
    const big = perLink(1000);
    // Quadratic: ~250 vs ~1000, one split per candidate per link. Linear: both
    // a small constant. Four times the bucket must not cost four times as much.
    expect(big).toBeLessThan(small * 1.5 + 5);
  });

  it('costs a constant number of path splits per link, not one per colliding note', () => {
    expect(perLink(1000)).toBeLessThan(20);
  });
});
