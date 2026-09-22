import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { createLoreMcpServer } from '../src/mcp/server.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';
import { FIXTURE_VAULT, makeVault } from './helpers.js';

let client: Client;
let ctx: LoreContext;

function parseText(res: unknown): any {
  const r = res as { content: { type: string; text: string }[]; isError?: boolean };
  expect(r.isError ?? false).toBe(false);
  const t = r.content[0]!.text;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

beforeAll(async () => {
  const root = await makeVault(FIXTURE_VAULT);
  const config = ConfigSchema.parse({});
  const store = openStore(':memory:');
  await indexVault(store, root);
  let cached: LoreGraph | null = null;
  ctx = {
    root,
    config,
    store,
    provider: null,
    graph: () => (cached ??= buildGraph(store, config)),
    noteLinks: () => buildNoteLinkGraph(store),
    invalidateGraph: () => (cached = null),
    close: () => store.close(),
  };
  const server = createLoreMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

describe('mcp server', () => {
  it('lists all tools', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'lore_aggregate_facts',
      'lore_assert_fact',
      'lore_capture',
      'lore_context_pack',
      'lore_dream_report',
      'lore_index',
      'lore_invalidate_fact',
      'lore_mark_used',
      'lore_propose_facts',
      'lore_query_facts',
      'lore_read_note',
      'lore_resume',
      'lore_review',
      'lore_search',
      'lore_timeline',
    ]);
  });

  it('propose_facts surfaces prose candidates without asserting them', async () => {
    const before = parseText(
      await client.callTool({ name: 'lore_query_facts', arguments: { includeHistory: true } }),
    ).facts.length;
    const res = parseText(
      await client.callTool({ name: 'lore_propose_facts', arguments: { limit: 20 } }),
    );
    expect(Array.isArray(res.candidates)).toBe(true);
    // proposing must not write anything
    const after = parseText(
      await client.callTool({ name: 'lore_query_facts', arguments: { includeHistory: true } }),
    ).facts.length;
    expect(after).toBe(before);
    // every candidate carries provenance back to its source
    for (const c of res.candidates) expect(c.source).toMatch(/\.md/);
  });

  it('search returns a lean, actionable shape by default', async () => {
    const res = parseText(
      await client.callTool({ name: 'lore_search', arguments: { query: 'meltwater sensor' } }),
    );
    expect(res[0].note).toBe('data/glacier-dataset.md');
    expect(typeof res[0].text).toBe('string');
    expect(res[0].match).toMatch(/query terms|linked/);
    // score internals are noise for an agent and cost real context
    expect(res[0].parts).toBeUndefined();
    expect(res[0].score).toBeUndefined();
  });

  it('verbose search still exposes score internals', async () => {
    const res = parseText(
      await client.callTool({
        name: 'lore_search',
        arguments: { query: 'meltwater sensor', verbose: true },
      }),
    );
    expect(res[0].notePath).toBe('data/glacier-dataset.md');
    expect(res[0].parts).toBeDefined();
    expect(typeof res[0].score).toBe('number');
  });

  it('the lean shape is materially cheaper than the verbose one', async () => {
    const lean = parseText(
      await client.callTool({ name: 'lore_search', arguments: { query: 'riverbed protocol' } }),
    );
    const full = parseText(
      await client.callTool({
        name: 'lore_search',
        arguments: { query: 'riverbed protocol', verbose: true },
      }),
    );
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(full).length * 0.75);
  });

  it('context pack orients a session', async () => {
    const res = parseText(
      await client.callTool({
        name: 'lore_context_pack',
        arguments: { topic: 'riverbed protocol' },
      }),
    );
    expect(res.stats.notes).toBeGreaterThan(0);
    expect(res.currentFacts.length).toBeGreaterThan(0);
    expect(res.topicHits.length).toBeGreaterThan(0);
  });

  it('fact lifecycle over MCP: assert → query → asOf → aggregate', async () => {
    parseText(
      await client.callTool({
        name: 'lore_assert_fact',
        arguments: {
          subject: 'Ambuj',
          predicate: 'lives_in',
          object: 'Lucknow',
          validFrom: '2020-01-01',
        },
      }),
    );
    const r2 = parseText(
      await client.callTool({
        name: 'lore_assert_fact',
        arguments: {
          subject: 'Ambuj',
          predicate: 'lives_in',
          object: 'Hyderabad',
          validFrom: '2025-11-01',
        },
      }),
    );
    expect(r2.superseded).toHaveLength(1);

    const current = parseText(
      await client.callTool({
        name: 'lore_query_facts',
        arguments: { subject: 'Ambuj', predicate: 'lives_in' },
      }),
    );
    // { facts, truncated? }: a bare array could not say it was a sample.
    expect(current.facts).toHaveLength(1);
    expect(current.truncated).toBeUndefined();
    expect(current.facts[0].object).toBe('Hyderabad');

    const past = parseText(
      await client.callTool({
        name: 'lore_query_facts',
        arguments: { subject: 'Ambuj', predicate: 'lives_in', asOf: '2022-05-05' },
      }),
    );
    expect(past.facts[0].object).toBe('Lucknow');

    const agg = parseText(
      await client.callTool({
        name: 'lore_aggregate_facts',
        arguments: { predicate: 'lives_in', groupBy: 'object' },
      }),
    );
    expect(agg.groups.length).toBeGreaterThanOrEqual(2);
    expect(agg.totalGroups).toBeGreaterThanOrEqual(agg.groups.length);
  });

  it('read_note returns markdown; path traversal is refused', async () => {
    const md = parseText(
      await client.callTool({
        name: 'lore_read_note',
        arguments: { path: 'people/amara-osei.md' },
      }),
    );
    expect(md).toContain('Amara Osei');

    const bad = (await client.callTool({
      name: 'lore_read_note',
      arguments: { path: '../../etc/passwd' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('escapes the vault');
  });

  it('capture, mark_used, dream_report, index all work', async () => {
    const cap = parseText(
      await client.callTool({ name: 'lore_capture', arguments: { text: 'note from mcp' } }),
    );
    expect(cap.captured).toBe('lore/inbox.md');

    const used = parseText(
      await client.callTool({
        name: 'lore_mark_used',
        arguments: { notePath: 'data/glacier-dataset.md' },
      }),
    );
    expect(used.reinforced).toBeGreaterThan(0);

    const dream = parseText(
      await client.callTool({ name: 'lore_dream_report', arguments: {} }),
    );
    expect(dream.stats.notes).toBeGreaterThan(0);

    // capture self-indexes its write now, so the note is searchable without a
    // reindex — and the next index sees nothing left to do.
    const found = parseText(
      await client.callTool({ name: 'lore_search', arguments: { query: 'note from mcp' } }),
    );
    expect(found.some((h: { note: string }) => h.note.includes('inbox'))).toBe(true);
    const idx = parseText(await client.callTool({ name: 'lore_index', arguments: {} }));
    expect(idx.added + idx.updated).toBe(0);
  });

  it('validation errors surface as tool errors, not crashes', async () => {
    const bad = (await client.callTool({
      name: 'lore_assert_fact',
      arguments: { subject: 'x', predicate: 'p', object: 'o', validFrom: 'not-a-date' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('ISO date');
  });
});

describe('context pack says when it is showing a sample', () => {
  it('names what was truncated, out of how many, and what to call for the rest', async () => {
    // Every list in the pack is capped. An agent handed 30 of 120 facts with
    // nothing to indicate it will answer "we have no record of that" — a
    // truncation that reads as completeness is worse than a long list,
    // because it is indistinguishable from an answer.
    for (let i = 0; i < 60; i++) {
      await client.callTool({
        name: 'lore_assert_fact',
        arguments: {
          subject: `Bulk Subject ${i}`,
          predicate: 'status',
          object: `value ${i}`,
          validFrom: '2026-01-01',
        },
      });
    }
    const pack = parseText(await client.callTool({ name: 'lore_context_pack', arguments: {} }));
    expect(pack.stats.openFacts).toBeGreaterThan(pack.currentFacts.length);
    expect(pack.truncated?.currentFacts).toBeDefined();
    expect(pack.truncated.currentFacts.shown).toBe(pack.currentFacts.length);
    expect(pack.truncated.currentFacts.of).toBe(pack.stats.openFacts);
    expect(pack.truncated.currentFacts.rest).toBe('lore_query_facts');
  });

  it('says nothing when nothing was cut', async () => {
    // The field must be absent rather than empty, or every pack carries a
    // block of zeros an agent has to read past.
    const root = await makeVault({ 'only.md': '# Only\n\nOne small note.\n' });
    const store = openStore(':memory:');
    await indexVault(store, root);
    const config = ConfigSchema.parse({});
    let cached: LoreGraph | null = null;
    const small: LoreContext = {
      root, config, store, provider: null,
      graph: () => (cached ??= buildGraph(store, config)),
      noteLinks: () => buildNoteLinkGraph(store),
      invalidateGraph: () => { cached = null; },
      close: () => store.close(),
    };
    const srv = createLoreMcpServer(small);
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    const cli = new Client({ name: 'small', version: '0' });
    await Promise.all([cli.connect(c2), srv.connect(s2)]);
    const pack = parseText(await cli.callTool({ name: 'lore_context_pack', arguments: {} }));
    expect(pack.truncated).toBeUndefined();
    await cli.close();
    small.close();
  });
});

describe('the tool contracts describe what the tools do', () => {
  // An agent reads these to decide what to call and cannot notice when one is
  // stale. Two had drifted: aggregate_facts changed shape and gained a cap,
  // and context_pack gained the `truncated` field that exists precisely so a
  // caller knows a list is a sample — neither said so.
  it('aggregate_facts documents its shape, its cap, and offers the knob', async () => {
    const tools = (await client.listTools()).tools;
    const agg = tools.find((t) => t.name === 'lore_aggregate_facts')!;
    expect(agg.description).toContain('totalGroups');
    expect(agg.description).toContain('limit');
    // and the knob it names actually exists
    expect(Object.keys((agg.inputSchema as { properties?: object }).properties ?? {})).toContain(
      'limit',
    );
  });

  it('raising the limit really returns more groups', async () => {
    for (let i = 0; i < 120; i++) {
      await client.callTool({
        name: 'lore_assert_fact',
        arguments: {
          subject: `Bulk ${i}`, predicate: 'kind', object: `value ${i}`, validFrom: '2026-01-01',
        },
      });
    }
    const capped = parseText(
      await client.callTool({ name: 'lore_aggregate_facts', arguments: { predicate: 'kind' } }),
    );
    expect(capped.groups.length).toBe(100);
    expect(capped.totalGroups).toBeGreaterThan(100);

    const wider = parseText(
      await client.callTool({
        name: 'lore_aggregate_facts', arguments: { predicate: 'kind', limit: 500 },
      }),
    );
    expect(wider.groups.length).toBe(wider.totalGroups);
  }, 60_000);

  it('context_pack tells the caller that its lists are samples', async () => {
    const pack = (await client.listTools()).tools.find((t) => t.name === 'lore_context_pack')!;
    expect(pack.description).toContain('truncated');
  });
});

describe('the server stays fresh while the user edits', () => {
  it('an editor write becomes searchable without calling lore_index', async () => {
    // `lore serve --mcp` runs for a whole session with the user's editor open
    // beside it. Without a watcher, every search answered from whatever the
    // vault looked like at startup: a note saved mid-session was unfindable,
    // indefinitely, with nothing to say so. startMcpServer now attaches
    // watchVault; this test runs the same composition in-process.
    const root2 = await makeVault({ 'seed.md': '# Seed\n\nInitial note.\n' });
    const store2 = openStore(':memory:');
    await indexVault(store2, root2);
    const config2 = ConfigSchema.parse({});
    let g2: LoreGraph | null = null;
    const ctx2: LoreContext = {
      root: root2, config: config2, store: store2, provider: null,
      graph: () => (g2 ??= buildGraph(store2, config2)),
      noteLinks: () => buildNoteLinkGraph(store2),
      invalidateGraph: () => { g2 = null; },
      close: () => store2.close(),
    };
    const { watchVault } = await import('../src/watch.js');
    const watcher = watchVault(ctx2, { debounceMs: 100 });
    const srv = createLoreMcpServer(ctx2);
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    const cli2 = new Client({ name: 'fresh', version: '0' });
    await Promise.all([cli2.connect(c2), srv.connect(s2)]);
    await new Promise((r) => setTimeout(r, 150)); // let the OS watcher attach

    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(join(root2, 'editor.md'), '# Editor\n\nNUMBAT decision saved mid-session.\n');

    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const res = parseText(
        await cli2.callTool({ name: 'lore_search', arguments: { query: 'NUMBAT' } }),
      );
      found = res.length > 0;
    }
    expect(found).toBe(true);

    watcher.close();
    await cli2.close();
    ctx2.close();
  }, 20_000);
});
