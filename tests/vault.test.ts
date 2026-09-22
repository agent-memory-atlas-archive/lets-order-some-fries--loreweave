import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNote } from '../src/vault/parse.js';
import { scanVault } from '../src/vault/scan.js';

describe('parseNote', () => {
  it('parses frontmatter, title, tags', () => {
    const raw = `---\ntitle: My Note\ntags: [alpha, Beta]\n---\n\nBody with #inline-tag here.\n`;
    const n = parseNote('a/b.md', raw, 1);
    expect(n.title).toBe('My Note');
    expect(n.tags.sort()).toEqual(['alpha', 'beta', 'inline-tag']);
    expect(n.warnings).toEqual([]);
  });

  it('never executes code in frontmatter, whatever language the fence names', () => {
    // gray-matter's default engines include JavaScript, and its parser reads the
    // language after the opening fence — so a note beginning `---js` was eval'd
    // at index time. Vault notes are untrusted (shared vaults, synced folders,
    // notes written by other agents); this was remote code execution by
    // dropping a markdown file. Reproduced on the built CLI before this test.
    const g = globalThis as unknown as { __lw_frontmatter_ran?: boolean };
    delete g.__lw_frontmatter_ran;
    for (const lang of ['js', 'javascript', 'JS', 'coffee', 'cson']) {
      const raw = `---${lang}\n{ pwn: (globalThis.__lw_frontmatter_ran = true) }\n---\n# Innocent\n\nBody.\n`;
      const n = parseNote('evil.md', raw, 1);
      expect(g.__lw_frontmatter_ran, `${lang} frontmatter executed`).toBeUndefined();
      expect(n.frontmatter).toEqual({});
      expect(n.warnings.join(' ')).toMatch(/frontmatter/i);
      // the code must not be indexed as prose either
      expect(n.blocks.map((b) => b.text).join(' ')).not.toContain('__lw_frontmatter_ran');
      expect(n.title).toBe('Innocent');
    }
    // yaml and json frontmatter keep working exactly as before
    expect(parseNote('a.md', '---\ntitle: Real\n---\n\nx\n', 1).title).toBe('Real');
    expect(parseNote('b.md', '---json\n{"title": "Json"}\n---\n\nx\n', 1).title).toBe('Json');
  });

  it('survives broken frontmatter without throwing', () => {
    const raw = `---\ntitle: [unclosed\n  bad: {yaml\n---\n\nContent survives.\n`;
    const n = parseNote('x.md', raw, 1);
    expect(n.title).toBe('x');
    expect(n.warnings.length).toBeGreaterThan(0);
    expect(n.blocks.map((b) => b.text).join(' ')).toContain('Content survives');
  });

  it('splits heading-bounded blocks with stable nested anchors', () => {
    const raw = `Preamble text.\n\n# One\n\npara one\n\n## Two\n\npara two\n\n# Three\n\npara three\n`;
    const n = parseNote('n.md', raw, 1);
    const anchors = n.blocks.map((b) => b.anchor);
    expect(anchors).toEqual(['@0', 'One@0', 'One/Two@0', 'Three@0']);
    expect(n.blocks[2]!.heading).toBe('One/Two');
  });

  it('does not treat # lines inside code fences as headings', () => {
    const raw = 'Text\n\n```bash\n# not a heading\necho hi\n```\n\nmore text\n';
    const n = parseNote('n.md', raw, 1);
    expect(n.blocks.length).toBe(1);
    expect(n.blocks[0]!.text).toContain('# not a heading');
  });

  it('parses the wiki-link matrix', () => {
    const raw = `See [[Target]], [[Other|shown]], [[Page#Section]], [[Deep#Part|alias]].`;
    const n = parseNote('n.md', raw, 1);
    expect(n.links).toHaveLength(4);
    expect(n.links[0]).toMatchObject({ target: 'Target', heading: undefined, alias: undefined });
    expect(n.links[1]).toMatchObject({ target: 'Other', alias: 'shown' });
    expect(n.links[2]).toMatchObject({ target: 'Page', heading: 'Section' });
    expect(n.links[3]).toMatchObject({ target: 'Deep', heading: 'Part', alias: 'alias' });
    expect(n.links[0]!.blockAnchor).toBe('@0');
  });

  it('splits oversized sections at paragraph borders with sequence anchors', () => {
    const para = 'word '.repeat(200).trim();
    const raw = `# Big\n\n${para}\n\n${para}\n\n${para}\n`;
    const n = parseNote('n.md', raw, 1);
    const bigAnchors = n.blocks.map((b) => b.anchor);
    expect(bigAnchors).toEqual(['Big@0', 'Big@1', 'Big@2']);
  });

  it('a note that is only a heading is still indexable', () => {
    // Stub notes (created by following a link) and index/MOC notes are often
    // nothing but headings. They produced zero blocks and were invisible: a
    // note titled "Quokka Protocol" could not be found by searching for it.
    const stub = parseNote('stub.md', '# Quokka Protocol\n', 1);
    expect(stub.blocks.length).toBeGreaterThan(0);
    expect(stub.blocks[0]!.text).toContain('Quokka Protocol');

    const moc = parseNote('moc.md', '# Index\n\n## Projects\n\n## People\n', 1);
    const text = moc.blocks.map((b) => b.text).join(' ');
    expect(text).toContain('Projects');
    expect(text).toContain('People');
  });

  it('an empty note is still findable by its name', () => {
    // Creating `Quokka Protocol.md` and leaving it empty is the same stub
    // workflow as a heading-only note; the filename is the content.
    const empty = parseNote('Quokka Protocol.md', '', 1);
    expect(empty.blocks).toHaveLength(1);
    expect(empty.blocks[0]!.text).toContain('Quokka Protocol');

    const ws = parseNote('Nimbus Ledger.md', '   \n\n  \n', 1);
    expect(ws.blocks[0]!.text).toContain('Nimbus Ledger');
  });

  it('headings with bodies are unaffected', () => {
    const n = parseNote('n.md', '# A\n\nbody of a\n\n## B\n\nbody of b\n', 1);
    expect(n.blocks.map((b) => b.text)).toEqual(['body of a', 'body of b']);
  });

  it('handles unicode content and paths', () => {
    const raw = `# Überblick\n\nNaïve café — 中文内容 #标签\n`;
    const n = parseNote('notes/日本語.md', raw, 1);
    expect(n.title).toBe('Überblick'); // H1 declares the title; the filename stays an alias
    expect(n.tags).toContain('标签');
    expect(n.blocks[0]!.heading).toBe('Überblick');
  });

  it('block hashes are content-stable', () => {
    const a = parseNote('a.md', '# H\n\nsame text\n', 1);
    const b = parseNote('b.md', '# H\n\nsame text\n', 999);
    expect(a.blocks[0]!.hash).toBe(b.blocks[0]!.hash);
  });
});

describe('scanVault', () => {
  it('finds md files recursively, skips ignored dirs, sorted output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lw-scan-'));
    await mkdir(join(root, 'sub'), { recursive: true });
    await mkdir(join(root, '.obsidian'), { recursive: true });
    await mkdir(join(root, '.lore'), { recursive: true });
    await writeFile(join(root, 'b.md'), 'b');
    await writeFile(join(root, 'sub', 'a.md'), 'a');
    await writeFile(join(root, 'sub', 'skip.txt'), 'x');
    await writeFile(join(root, '.obsidian', 'hidden.md'), 'x');
    await writeFile(join(root, '.lore', 'index.md'), 'x');
    const files = await scanVault(root);
    expect(files.map((f) => f.path)).toEqual(['b.md', 'sub/a.md']);
  });
});

describe('oversized sections keep their line structure', () => {
  it('a long list of fact lines survives the word cap', async () => {
    // Markdown is line-structured and several consumers read it that way:
    // `- [fact]` lines, Dataview fields, list items. Splitting an oversized
    // paragraph by rejoining words with spaces merged them all into one — a
    // note with 60 fact lines crossed the cap and 59 of the facts stopped
    // existing, leaving one whose object was the rest of the list. The same
    // note with 20 lines parsed perfectly, so it only broke past a size
    // nobody thinks about.
    const { parseFactLines } = await import('../src/facts/journal.js');
    for (const n of [20, 60, 300]) {
      const lines = Array.from(
        { length: n },
        (_, i) => `- [fact] Person${i} :: lives_in :: City ${i} {valid_from=2026-01-01}`,
      );
      const blocks = parseNote('f.md', `# Facts\n\n${lines.join('\n')}\n`, 1).blocks;
      const facts = blocks.flatMap((b) => parseFactLines(b.text));
      expect(facts, `${n} fact lines`).toHaveLength(n);
      expect(facts[0]!.object).toBe('City 0');
      expect(facts[n - 1]!.object).toBe(`City ${n - 1}`);
    }
  });

  it('a list of Dataview fields survives it too', async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `- field${i}:: value ${i}`);
    const note = parseNote('d.md', `# D\n\n${lines.join('\n')}\n`, 1);
    const { extractFactsFromNote } = await import('../src/facts/extract.js');
    const facts = extractFactsFromNote(note, 'explicit');
    expect(facts.length).toBe(80);
  });

  it('but a single line longer than the budget is still split', async () => {
    // The one case with no line boundary to use.
    const blocks = parseNote('l.md', `# L\n\n${'word '.repeat(900).trim()}\n`, 1).blocks;
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.text.split(/\s+/).length).toBeLessThanOrEqual(350);
  });
});

describe('code fences do not leak into the graph or the outline', () => {
  it('does not extract links from inside a fence split across blocks', async () => {
    // maskCode runs per block, but chunkText splits an oversized fenced block
    // into several once it passes the size cap. Every block after the first
    // lost its opening ```, so maskCode could no longer blank the code and a
    // [[wikilink]] written inside a code SAMPLE became a real graph edge.
    const filler = 'word '.repeat(400).trim();
    const n = parseNote(
      'n.md',
      '```md\n' + filler + '\n\nExample: [[SecretPhantom]] and also [clickme](./phantom.md)\n```\n',
      1,
    );
    expect(n.blocks.length).toBeGreaterThan(1); // the fence really did split
    expect(n.links).toEqual([]); // nothing from inside the code
  });

  it('still extracts real links around a code block', async () => {
    const n = parseNote(
      'n.md',
      'See [[RealTarget]] here.\n\n```\ncode with [[InCode]]\n```\n\nAnd [[AlsoReal]].\n',
      1,
    );
    const targets = n.links.map((l) => l.target).sort();
    expect(targets).toEqual(['AlsoReal', 'RealTarget']);
  });

  it('does not extract #tags from inside a code fence', async () => {
    // extractLinks masks code, extractInlineTags did not: the two extractors
    // drifted apart. A pasted stylesheet turned every hex colour into a tag and
    // a pasted C header turned #include/#define into tags — each one a
    // first-class entity, and each one fanned out to every block of the note.
    const n = parseNote(
      'snippet.md',
      'Prose with a #real-tag in it.\n\n' +
        '```css\n.a { color: #aabbcc; border-color: #ddeeff; }\n```\n\n' +
        '```c\n#include <stdio.h>\n#define BOUNDARY 1\n```\n\n' +
        'Closing prose.\n',
      1,
    );
    expect(n.tags).toEqual(['real-tag']);
  });

  it('does not extract #tags from a fence split across blocks', async () => {
    // Same carry-the-open-fence problem extractLinks already solves: chunkText
    // splits an oversized fenced block, and every chunk after the first lost
    // its opening ``` so masking alone could not blank it.
    const filler = 'word '.repeat(400).trim();
    const n = parseNote(
      'big.md',
      '```c\n' + filler + '\n\n#define PHANTOM 1\n#include <phantom.h>\n```\n',
      1,
    );
    expect(n.blocks.length).toBeGreaterThan(1); // the fence really did split
    expect(n.tags).toEqual([]);
  });

  it('tag count does not grow with the size of a pasted code block', async () => {
    // The property, not a wall-clock threshold: note-level tags fan out to
    // every block, so tags growing with pasted-code size made graph edges
    // quadratic in one note's length (measured: 167KB paste -> 279,807 edges).
    // distinct colour per rule, as a real stylesheet has — so the junk tag set
    // genuinely grows with the paste instead of deduplicating away
    const rule = (i: number) =>
      `.r${i} { color: #${i.toString(16).padStart(6, '0')}; background: #${(i + 4096)
        .toString(16)
        .padStart(6, '0')}; }`;
    const build = (n: number) =>
      'Notes about styling. #real-tag\n\n```css\n' +
      Array.from({ length: n }, (_, i) => rule(i)).join('\n') +
      '\n```\n';
    const small = parseNote('s.md', build(50), 1);
    const large = parseNote('l.md', build(800), 1);
    expect(large.blocks.length).toBeGreaterThan(small.blocks.length); // really bigger
    expect(small.tags).toEqual(['real-tag']);
    expect(large.tags).toEqual(['real-tag']);
  });

  it('a ~~~ line inside a ``` fence does not turn code into a heading', async () => {
    // splitSections tracked a single inFence boolean and flipped it on ANY
    // fence marker, so a lone ~~~ inside a ``` block turned fence state OFF and
    // the `# ...` code lines after it were parsed as real headings, mis-filing
    // the prose that followed the block.
    const n = parseNote(
      'n.md',
      'Intro.\n\n```\n~~~\n# This is code, not a heading\nmore code\n```\n\nOutro paragraph.\n',
      1,
    );
    const headings = n.blocks.map((b) => b.heading);
    expect(headings).not.toContain('This is code, not a heading');
    // and the real outro prose is findable, not swallowed into a code heading
    expect(n.blocks.some((b) => b.text.includes('Outro paragraph'))).toBe(true);
  });
});
