import { describe, expect, it } from 'vitest';
import { parseNote } from '../src/vault/parse.js';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { makeVault } from './helpers.js';

/**
 * YAML anchors let a few hundred bytes of frontmatter describe an
 * exponentially large structure. js-yaml resolves aliases by SHARING the
 * referenced node, so parsing one is cheap; it is the deep copy in
 * normalizeFrontmatterValue — and the JSON.stringify of its output on the way
 * into the index — that materialises every path through the graph. A note
 * written by anyone (shared vault, sync folder, another agent) could therefore
 * decide how much memory the indexer allocates.
 */
function aliasBomb(depth: number, tail = ''): string {
  let fm = '---\n';
  fm += 'a0: &a0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]\n';
  for (let i = 1; i <= depth; i++) {
    const refs = new Array(9).fill(`*a${i - 1}`).join(',');
    fm += `a${i}: &a${i} [${refs}]\n`;
  }
  fm += tail;
  fm += '---\n# Shared meeting notes\n\nSee [[Project Plan]].\n';
  return fm;
}

describe('frontmatter that expands', () => {
  it('a note whose frontmatter expands past the budget is truncated, not materialised', () => {
    // depth 5 => 9^6 = 531,441 leaves from 250-odd bytes. Deliberately below
    // the depth that exhausts the heap, so the failure is measurable rather
    // than fatal; depth 8 is the same note and kills the process.
    const raw = aliasBomb(5, 'title: Shared Meeting Notes\n');
    expect(raw.length).toBeLessThan(600);

    const note = parseNote('shared-note.md', raw, 1_700_000_000_000);

    const bytes = JSON.stringify(note.frontmatter).length;
    expect(bytes).toBeLessThan(200_000);
    expect(note.warnings.some((w) => /frontmatter/i.test(w) && /truncat/i.test(w))).toBe(true);
    // the note is still a note: its body parsed, and the honest keys survive
    expect(note.title).toBe('Shared Meeting Notes');
    expect(note.frontmatter.title).toBe('Shared Meeting Notes');
    expect(note.links.map((l) => l.target)).toContain('Project Plan');
  });

  it('honest frontmatter, even a long one, is kept whole and unwarned', () => {
    const tags = Array.from({ length: 400 }, (_, i) => `t${i}`);
    const raw = `---\ntitle: Big But Honest\ntags: [${tags.join(',')}]\n---\n\n# Body\n\nreal text\n`;
    const note = parseNote('honest.md', raw, 1_700_000_000_000);
    expect((note.frontmatter.tags as string[]).length).toBe(400);
    expect(note.warnings).toEqual([]);
  });

  it('a vault holding such a note still indexes, and its other notes stay searchable', async () => {
    const root = await makeVault({
      'shared-note.md': aliasBomb(5),
      'project-plan.md': '# Project Plan\n\nThe quokka protocol ships in March.\n',
    });
    const store = openStore(':memory:');
    const report = await indexVault(store, root);
    expect(report.warnings.some((w) => w.startsWith('shared-note.md:'))).toBe(true);
    expect(store.searchLexical('quokka', 5).map((h) => h.notePath)).toEqual(['project-plan.md']);
    const row = store.db.prepare(`SELECT frontmatter FROM notes WHERE path='shared-note.md'`).get() as
      | { frontmatter: string }
      | undefined;
    expect((row?.frontmatter ?? '').length).toBeLessThan(200_000);
    store.close();
  });
});
