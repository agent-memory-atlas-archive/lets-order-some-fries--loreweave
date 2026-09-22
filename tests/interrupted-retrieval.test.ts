import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildProgram } from '../src/cli/main.js';
import { openContext, ensureIndexed } from '../src/context.js';
import { createLoreMcpServer } from '../src/mcp/server.js';
import { indexVault, indexState } from '../src/index/indexer.js';
import { search } from '../src/retrieve/search.js';
import { FIXTURE_VAULT, makeVault } from './helpers.js';

/**
 * An index interrupted part-way through its FIRST build is the empty-index lie
 * with better camouflage. Measured on a 3 000-note synthetic vault, Ctrl-C at
 * 1.2 s left 1 548 notes indexed (52%) and a dead PID in
 * `meta.index_in_progress`; `lore stats` and `lore doctor` both said
 * "index: INCOMPLETE", but `lore search marker02250` — for a note that is
 * sitting in the vault — printed "no results" and exited 0, and over MCP
 * `lore_search` returned `[]` while `lore_context_pack` reported
 * `stats.notes: 1548` with no incomplete signal anywhere in the payload.
 * SIGINT, SIGTERM and SIGHUP all produce the identical state, so the trigger
 * is an ordinary Ctrl-C, not a crash.
 */

/** A PID that certainly names no live process: a child we spawned and reaped. */
function deadPid(): string {
  const child = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid;
  if (!pid || pid === process.pid) throw new Error('could not obtain a reaped pid');
  return String(pid);
}

describe('retrieval on an index left half-built', () => {
  it('repairs rather than answering from the half it happens to hold', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    await indexVault(ctx.store, root);
    const whole = (ctx.store.db.prepare('SELECT COUNT(*) c FROM notes').get() as { c: number }).c;
    expect(whole).toBeGreaterThan(2);

    // Exactly what a Ctrl-C mid-build leaves: some notes in, the rest never
    // reached, and a marker naming a process that is gone.
    ctx.store.db.prepare(`DELETE FROM notes WHERE path LIKE 'data/%'`).run();
    ctx.store.setMeta('index_in_progress', deadPid());
    ctx.invalidateGraph();
    expect(indexState(ctx.store)).toBe('interrupted');
    expect(await search(ctx, 'meltwater sensor readings', { k: 5, noLog: true })).toEqual([]);

    // The rule ensureIndexed already enforces — never answer from an index
    // that was never built — has to cover an index known to be half-built.
    const repaired = await ensureIndexed(ctx);
    expect(repaired).toBe(true);
    expect(indexState(ctx.store)).toBe('clean');
    expect(
      (ctx.store.db.prepare('SELECT COUNT(*) c FROM notes').get() as { c: number }).c,
    ).toBe(whole);

    const hits = await search(ctx, 'meltwater sensor readings', { k: 5, noLog: true });
    expect(hits.some((h) => h.notePath.includes('glacier'))).toBe(true);
    ctx.close();
  });

  it('announces the rebuild before it starts, not after', async () => {
    // An unannounced full index behind what looked like a cheap read is its
    // own surprise, and on an embedding-configured vault it is a long one.
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    await indexVault(ctx.store, root);
    ctx.store.db.prepare(`DELETE FROM notes WHERE path LIKE 'data/%'`).run();
    ctx.store.setMeta('index_in_progress', deadPid());

    const first: number[] = [];
    const repair: number[] = [];
    await ensureIndexed(
      ctx,
      (n) => first.push(n),
      (n) => repair.push(n),
    );
    expect(first).toEqual([]); // not a first run: the index exists
    expect(repair).toHaveLength(1);
    ctx.close();
  });

  it('leaves a healthy index alone', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    await indexVault(ctx.store, root);
    const repair: number[] = [];
    expect(await ensureIndexed(ctx, undefined, (n) => repair.push(n))).toBe(false);
    expect(repair).toEqual([]);
    ctx.close();
  });

  it('does not repair while another process is genuinely still indexing', async () => {
    const root = await makeVault(FIXTURE_VAULT);
    const ctx = openContext(root);
    await indexVault(ctx.store, root);
    ctx.store.setMeta('index_in_progress', String(process.ppid)); // alive
    expect(indexState(ctx.store)).toBe('running');
    expect(await ensureIndexed(ctx)).toBe(false);
    ctx.close();
  });
});

describe('a half-built index that cannot be repaired', () => {
  // A read-only `.lore` — a vault on a read-only mount, a backup opened in
  // place — cannot be rebuilt, so the caveat is all that is left. It must not
  // become an exception either: ensureIndexed has never written on this path,
  // and store.assertWritable() throws.
  let root: string;
  let dbFile: string;

  const run = async (...args: string[]): Promise<{ out: string; err: string }> => {
    const out: string[] = [];
    const err: string[] = [];
    const program = buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s) });
    program.exitOverride();
    for (const c of program.commands) c.exitOverride();
    await program.parseAsync(['node', 'lore', '--vault', root, ...args]);
    return { out: out.join('\n'), err: err.join('\n') };
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lw-int-ro-'));
    await mkdir(join(root, '.lore'), { recursive: true });
    await writeFile(join(root, 'heron.md'), '# Heron\n\nThe heron stands in the shallows.\n');
    const ctx = openContext(root);
    await indexVault(ctx.store, ctx.root);
    ctx.store.setMeta('index_in_progress', deadPid());
    ctx.close();
    dbFile = join(root, '.lore', 'index.db');
    await chmod(dbFile, 0o444);
    await chmod(join(root, '.lore'), 0o555);
  });

  afterAll(async () => {
    await chmod(join(root, '.lore'), 0o755);
    await chmod(dbFile, 0o644);
  });

  it('answers, and says on stderr that the answer describes a partial index', async () => {
    const r = await run('search', 'heron');
    expect(r.out).toContain('heron.md');
    expect(r.err).toContain('INCOMPLETE');
    // stdout stays exactly what it was, so nothing parsing `lore search` moves.
    expect(r.out).not.toContain('INCOMPLETE');
  });

  it('carries the caveat into the MCP context pack', async () => {
    const ctx = openContext(root);
    await ensureIndexed(ctx); // must not throw on a read-only store
    const server = createLoreMcpServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([client.connect(ct), server.connect(st)]);
    try {
      const res = (await client.callTool({
        name: 'lore_context_pack',
        arguments: {},
      })) as { isError?: boolean; content: { text: string }[] };
      expect(res.isError ?? false).toBe(false);
      const pack = JSON.parse(res.content[0]!.text);
      expect(pack.stats.indexIncomplete).toBe(true);
    } finally {
      await client.close();
      ctx.close();
    }
  });
});
