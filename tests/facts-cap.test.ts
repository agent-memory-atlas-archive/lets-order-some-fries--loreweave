import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildProgram } from '../src/cli/main.js';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { createLoreMcpServer } from '../src/mcp/server.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';
import { queryFacts, queryFactsPage } from '../src/facts/model.js';
import { makeVault } from './helpers.js';

/**
 * The fact store is the one surface that is supposed to be authoritative
 * rather than fuzzy, and `queryFacts` capped at 200 rows in alphabetical
 * subject order with nothing said. Past 200 facts, `lore ask` and the MCP
 * `lore_query_facts` tool reported that a fact does not exist when it does —
 * and which facts vanished depended on the first letter of the subject.
 */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function peopleNote(): string {
  const lines = ['# People', ''];
  let n = 0;
  for (const L of LETTERS) {
    for (let i = 1; i <= 10; i++) {
      n++;
      const who = `${L}name${String(i).padStart(2, '0')}`;
      const city = `City${String(n).padStart(3, '0')}`;
      lines.push(`- [fact] ${who} :: location :: ${city} {valid_from=2026-01-01, source=stated}`);
    }
  }
  return lines.join('\n') + '\n';
}

async function vault(): Promise<string> {
  const root = await makeVault({ 'people.md': peopleNote() });
  await mkdir(join(root, '.lore'), { recursive: true });
  return root;
}

async function cli(root: string, ...args: string[]): Promise<string> {
  const out: string[] = [];
  const program = buildProgram({ out: (s) => out.push(s), err: () => {} });
  program.exitOverride();
  for (const c of program.commands) c.exitOverride();
  await program.parseAsync(['node', 'lore', '--vault', root, ...args]);
  return out.join('\n');
}

async function mcpClient(root: string): Promise<Client> {
  const config = ConfigSchema.parse({});
  const store = openStore(':memory:');
  await indexVault(store, root);
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
  const server = createLoreMcpServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}

function parsed(res: unknown): any {
  const r = res as { content: { type: string; text: string }[] };
  return JSON.parse(r.content[0]!.text);
}

describe('more facts than one page of them', () => {
  it('answers about a subject at the end of the alphabet as readily as one at the start', async () => {
    const root = await vault();
    await cli(root, 'index');
    const early = JSON.parse(await cli(root, 'ask', 'where does Bname03 live', '--json'));
    const late = JSON.parse(await cli(root, 'ask', 'where does Zname03 live', '--json'));
    expect(early.facts.map((f: any) => f.object)).toEqual(['City013']);
    expect(late.facts.map((f: any) => f.object)).toEqual(['City253']);
  });

  it('reports how many facts there are when it returns only some of them', async () => {
    const root = await vault();
    const store = openStore(':memory:');
    await indexVault(store, root);
    const page = queryFactsPage(store, {});
    expect(page.total).toBe(260);
    expect(page.facts).toHaveLength(page.limit);
    expect(page.limit).toBeLessThan(260);
    // and the cap can be lifted by a caller that wants everything
    expect(queryFacts(store, { limit: 5000 })).toHaveLength(260);
    store.close();
  });

  it('`lore facts` says what it left out, and --limit gets the rest', async () => {
    const root = await vault();
    await cli(root, 'index');
    const capped = await cli(root, 'facts');
    expect(capped).toMatch(/260/);
    expect(capped).toMatch(/--limit/);
    const all = await cli(root, 'facts', '--limit', '1000');
    expect(all).toContain('Zname03 :: location :: City253');
  });

  it('lore_query_facts takes a limit and declares its truncation', async () => {
    const root = await vault();
    const client = await mcpClient(root);
    const first = parsed(
      await client.callTool({ name: 'lore_query_facts', arguments: {} }),
    );
    expect(first.facts).toHaveLength(200);
    // shape, not wording: an agent needs the two numbers and a way out. The
    // hint's exact phrasing is allowed to change without breaking this.
    expect(first.truncated).toMatchObject({ shown: 200, of: 260 });
    expect(first.truncated.rest).toMatch(/limit|subject/);
    const all = parsed(
      await client.callTool({ name: 'lore_query_facts', arguments: { limit: 1000 } }),
    );
    expect(all.facts).toHaveLength(260);
    expect(all.truncated).toBeUndefined();
  });
});
