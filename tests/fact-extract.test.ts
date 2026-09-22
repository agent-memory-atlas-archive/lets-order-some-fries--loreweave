import { describe, expect, it } from 'vitest';
import { parseNote } from '../src/vault/parse.js';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { queryFacts } from '../src/facts/model.js';
import { extractFactsFromNote } from '../src/facts/extract.js';
import { parseNote } from '../src/vault/parse.js';
import { makeVault } from './helpers.js';

describe('fact extraction tiers', () => {
  it('reads frontmatter, inline fields and observations; skips file metadata', () => {
    const raw = `---
title: Ledger Format
status: draft
tags: [infra, storage]
---

# Ledger

- owner:: Priya Sharma
- [format] columnar
- **Deputy:** Sam Okoro
`;
    const explicit = extractFactsFromNote(parseNote('a.md', raw, 1));
    const keys = explicit.map((f) => `${f.predicate}=${f.object}`);
    expect(keys).toContain('status=draft');
    expect(keys).toContain('owner=Priya Sharma');
    expect(keys).toContain('format=columnar');
    // title/tags describe the file, not the thing
    expect(explicit.some((f) => f.predicate === 'title')).toBe(false);
    expect(explicit.some((f) => f.predicate === 'tags')).toBe(false);
    // prose formatting is opt-in
    expect(keys).not.toContain('Deputy=Sam Okoro');
    const all = extractFactsFromNote(parseNote('a.md', raw, 1), 'all');
    expect(all.map((f) => `${f.predicate}=${f.object}`)).toContain('Deputy=Sam Okoro');
  });

  it('a fact whose object repeats its subject is dropped', () => {
    // `name: writing-skills` on a note titled writing-skills states nothing,
    // and showed up as noise in `ask` output on a real corpus.
    const raw = '---\ntitle: writing-skills\nname: writing-skills\nstatus: stable\n---\n\n# X\n\nBody.\n';
    const facts = extractFactsFromNote(parseNote('a.md', raw, 1));
    expect(facts.some((f) => f.predicate === 'name')).toBe(false);
    // an informative value on the same key survives
    expect(facts.map((f) => f.predicate)).toContain('status');
  });

  it('task list items are never facts', () => {
    const raw = `---\ntitle: PR\n---\n\n- [x] Bug fix (non-breaking change)\n- [ ] New feature\n`;
    const facts = extractFactsFromNote(parseNote('pr.md', raw, 1), 'all');
    expect(facts.some((f) => f.predicate === 'x' || f.predicate === '')).toBe(false);
    expect(facts).toHaveLength(0);
  });

  it('a frontmatter date becomes valid_from, so as-of can see it', async () => {
    // gray-matter yields a Date; JSON storage makes it a datetime string —
    // a date-only check silently dropped it.
    const root = await makeVault({
      'l.md': '---\ntitle: Ledger\nstatus: draft\ndate: 2026-01-15\n---\n\n# Ledger\n\nBody.\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);
    const now = queryFacts(store, { subject: 'Ledger' });
    expect(now[0]!.validFrom).toBe('2026-01-15');
    expect(queryFacts(store, { subject: 'Ledger', asOf: '2026-06-01' })).toHaveLength(1);
    expect(queryFacts(store, { subject: 'Ledger', asOf: '2025-06-01' })).toHaveLength(0);
    store.close();
  });

  it('trailing {valid_until=…} closes the fact on every form, not just [fact]', async () => {
    // The sibling key valid_from has worked on all three forms since the
    // commit above. valid_until was read out of the same attribute block and
    // then dropped on the floor by the extracted-fact INSERT, so the vault
    // said a contract ended in June and the store said it is still running.
    const root = await makeVault({
      'atlas.md':
        '# Project Atlas\n\n' +
        '- vendor:: Northwind Ltd {valid_from=2026-02-01, valid_until=2026-06-01}\n' +
        '- [vendor2] Southwind Ltd {valid_from=2026-02-01, valid_until=2026-06-01}\n' +
        '- [fact] Project Atlas :: vendor3 :: Eastwind Ltd {valid_from=2026-02-01, valid_until=2026-06-01}\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);
    const all = queryFacts(store, { subject: 'Project Atlas', includeHistory: true });
    expect(Object.fromEntries(all.map((f) => [f.predicate, f.validUntil]))).toEqual({
      vendor: '2026-06-01',
      vendor2: '2026-06-01',
      vendor3: '2026-06-01',
    });
    // inside the window all three are current …
    expect(queryFacts(store, { subject: 'Project Atlas', asOf: '2026-04-01' })).toHaveLength(3);
    // … and three months after every contract ended, none of them is
    expect(queryFacts(store, { subject: 'Project Atlas', asOf: '2026-09-01' })).toHaveLength(0);
    expect(queryFacts(store, { subject: 'Project Atlas' })).toHaveLength(0);
    store.close();
  });

  it('a frontmatter date is a fallback, not an override of a line that states its own', async () => {
    // The note-level date is documented as dating "the whole note's
    // assertions", and it was applied with `=` after every line had already
    // been parsed — so the more specific signal always lost to the less
    // specific one. `date:` and `created:` are standard Obsidian frontmatter
    // that template and daily-note plugins insert by default, so any note
    // carrying one and also using `{valid_from=…}` was silently re-dated to
    // when the file was created.
    const raw =
      '---\ntitle: Project Atlas\ndate: 2026-01-01\n---\n\n# Project Atlas\n\n' +
      '- owner:: Priya Raman {valid_from=2026-07-15}\n' +
      '- vendor:: Northwind Ltd {valid_from=2026-02-01}\n' +
      '- stage:: fieldwork\n';
    const got = extractFactsFromNote(parseNote('atlas.md', raw, 1));
    expect(Object.fromEntries(got.map((f) => [f.predicate, f.validFrom]))).toMatchObject({
      owner: '2026-07-15',
      vendor: '2026-02-01',
      // the line that states no date of its own still takes the note's
      stage: '2026-01-01',
    });

    // and the as-of answer moves with it: in March the owner had not started
    const root = await makeVault({ 'atlas.md': raw });
    const store = openStore(':memory:');
    await indexVault(store, root);
    const asOf = (d: string) =>
      queryFacts(store, { subject: 'Project Atlas', asOf: d }).map((f) => f.predicate).sort();
    expect(asOf('2026-03-01')).toEqual(['stage', 'vendor']);
    expect(asOf('2026-08-01')).toEqual(['owner', 'stage', 'vendor']);
    store.close();
  });

  it('an explicit [fact] line beats an extracted one for the same slot', async () => {
    const root = await makeVault({
      'l.md': '---\ntitle: Ledger\nstatus: draft\n---\n\n# Ledger\n\nBody.\n',
      'lore/journal/2026-08-01.md':
        '# J\n\n- [fact] Ledger :: status :: shipped {valid_from=2026-08-01}\n',
    });
    const store = openStore(':memory:');
    await indexVault(store, root);
    const rows = queryFacts(store, { subject: 'Ledger', predicate: 'status', includeHistory: true });
    expect(rows.map((r) => r.object)).toEqual(['shipped']);
    expect(rows[0]!.sourceType).toBe('stated');
    store.close();
  });
});

describe('values the vault actually contains', () => {
  const facts = (raw: string, mode: 'explicit' | 'all' = 'explicit') =>
    extractFactsFromNote(parseNote('f.md', raw, 1), mode);

  it('a frontmatter date stays the date that was written', () => {
    // YAML turns a bare date into a Date and the frontmatter is stored as
    // JSON, so it read back as "2025-03-01T00:00:00.000Z" — a timestamp with a
    // timezone nobody wrote, which then became the literal object of a fact.
    // A guard for this existed in this file and was dead: it tested
    // `instanceof Date` on a value JSON had already turned into a string.
    const f = facts('---\nstarted: 2025-03-01\n---\n\nbody\n');
    expect(f.find((x) => x.predicate === 'started')?.object).toBe('2025-03-01');
  });

  it('a real time of day is not truncated to a date', () => {
    const f = facts('---\ndeployed: 2025-03-01T09:30:00Z\n---\n\nbody\n');
    expect(f.find((x) => x.predicate === 'deployed')?.object).toContain('09:30');
  });

  it('trailing {valid_from=…} is honoured on every fact form, not just [fact]', () => {
    // The journal writes this syntax on every line it emits, but only the
    // `- [fact]` form read it back. Elsewhere the braces were swallowed whole
    // into the object: the date was lost AND it corrupted the value.
    const dv = facts('# N\n\n- role:: Staff Engineer {valid_from=2025-06-01}\n');
    const role = dv.find((x) => x.predicate === 'role');
    expect(role?.object).toBe('Staff Engineer');
    expect(role?.validFrom).toBe('2025-06-01');

    const obs = facts('# N\n\n- [team] Platform {valid_from=2024-02-03, confidence=0.5}\n');
    const team = obs.find((x) => x.predicate === 'team');
    expect(team?.object).toBe('Platform');
    expect(team?.validFrom).toBe('2024-02-03');
    expect(team?.confidence).toBe(0.5);
  });

  it('braces that are not metadata are left in the value', () => {
    const f = facts('# N\n\n- format:: {"a": 1}\n');
    expect(f.find((x) => x.predicate === 'format')?.object).toContain('{');
  });

  it('a Dataview field on its own line is read, not only inside a list', () => {
    // Obsidian users write `key:: value` on a bare line at least as often as
    // inside a list; reading only the list form silently ignored half of a
    // convention the README claims to support.
    const f = facts('# N\n\nrole:: Staff Engineer\nteam:: Platform\n');
    expect(f.map((x) => `${x.predicate}=${x.object}`)).toEqual(
      expect.arrayContaining(['role=Staff Engineer', 'team=Platform']),
    );
  });

  it('a scope operator in code is not a field', () => {
    // The space after `::` is what separates them: std::vector, Foo::bar and
    // every scope operator in every language has none.
    expect(facts('# N\n\n```cpp\nstd::vector<int> v;\n```\n')).toEqual([]);
    expect(facts('# N\n\nWe call std::vector and Foo::bar directly.\n')).toEqual([]);
    expect(facts('# N\n\nuse serde::Serialize;\n')).toEqual([]);
  });
});
