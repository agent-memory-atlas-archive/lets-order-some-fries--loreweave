import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, readNoteRaw } from '../src/capture.js';
import { scanVault, whyNotNote } from '../src/vault/scan.js';
import { indexVault } from '../src/index/indexer.js';
import { openContext, ensureIndexed } from '../src/context.js';
import { parseNote } from '../src/vault/parse.js';
import { openStore } from '../src/store/db.js';
import { ConfigSchema } from '../src/config.js';

/** capture self-indexes its write, so it needs a real store and config. */
function miniCtx(root: string, ignore: string[] = []) {
  return {
    root,
    config: ConfigSchema.parse({ ignore }),
    store: openStore(':memory:'),
  } as never;
}

/**
 * Three code paths decide what a note is — the scanner (what gets indexed),
 * `readNoteRaw` (what `lore_read_note` hands back) and `capture` (where the
 * engine will write) — and they disagreed. Every disagreement leaked something:
 * `read_note` served files the scanner skips on purpose, the scanner indexed a
 * symlink whose target was never a note, and `capture` wrote into places the
 * next index deletes. The tests here pin the one answer all three now share.
 */
async function hiddenDirVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lw-gate-'));
  for (const d of ['.private', '.obsidian/plugins/x', 'node_modules/pkg', '.lore', '.git']) {
    await mkdir(join(root, d), { recursive: true });
  }
  await writeFile(join(root, 'a.md'), '# A\n');
  await writeFile(join(root, '.private', 'diary.md'), '# Diary\n\nHIDDEN-DIARY-TEXT\n');
  await writeFile(join(root, '.obsidian', 'plugins', 'x', 'README.md'), 'PLUGIN-README\n');
  await writeFile(join(root, 'node_modules', 'pkg', 'README.md'), 'PKG-README\n');
  await writeFile(join(root, '.lore', 'notes.md'), 'LORE-DIR-NOTE\n');
  await writeFile(join(root, '.git', 'COMMIT_EDITMSG.md'), 'GIT-MSG\n');
  return root;
}

/** Every file reachable under `root`, hidden ones and symlinks included. */
async function everyFile(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = (await stat(join(dir, e.name))).isDirectory();
        } catch {
          out.push(r); // dangling: still a path someone could ask for
          continue;
        }
      }
      if (isDir) await walk(join(dir, e.name), r);
      else out.push(r);
    }
  }
  await walk(root, '');
  return out.sort();
}

describe('what counts as a note', () => {
  it('read_note serves exactly what the scanner indexes — hidden and ignored dirs included', async () => {
    // readNoteRaw's own docstring says its condition "mirrors vault/scan.ts".
    // The scanner skips dot-directories and DEFAULT_IGNORES at every depth;
    // the gate checked only the basename, so `.private/diary.md` was never
    // indexed, never in any answer, and handed back in full anyway.
    const root = await hiddenDirVault();
    const indexed = new Set((await scanVault(root)).map((f) => f.path));
    const probes = [
      'a.md',
      '.private/diary.md',
      '.obsidian/plugins/x/README.md',
      'node_modules/pkg/README.md',
      '.lore/notes.md',
      '.git/COMMIT_EDITMSG.md',
    ];
    const mismatches: string[] = [];
    for (const rel of probes) {
      let readable = false;
      try {
        readNoteRaw(root, rel);
        readable = true;
      } catch {
        readable = false;
      }
      if (readable !== indexed.has(rel)) {
        mismatches.push(`${rel}: indexed=${indexed.has(rel)} readable=${readable}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(indexed.has('a.md')).toBe(true);
  });

  it('capture refuses to write where the scanner will never look', async () => {
    // Measured: `capture --to .lore/scratch.md` exited 0, the line was
    // searchable, and the next `lore index` reported `-1` and it was gone.
    // `lore/digests/x.md` was never searchable at all — indexNoteFile skips
    // the derived prefix, so the write succeeded into a void.
    const root = await hiddenDirVault();
    const ctx = miniCtx(root, ['drafts']);
    const outcomes: string[] = [];
    for (const rel of [
      '.private/new.md',
      '.lore/new.md',
      'node_modules/new.md',
      'lore/digests/new.md',
      'lore/review-queue.md',
      'drafts/new.md',
      'sub/.hidden.md',
    ]) {
      try {
        capture(ctx, 'ORPHAN-CAPTURE', rel);
        outcomes.push(`${rel}: WRITTEN`);
      } catch (e) {
        outcomes.push(`${rel}: refused (${(e as Error).message})`);
      }
    }
    expect(outcomes.filter((o) => o.endsWith('WRITTEN'))).toEqual([]);
    // and the refusal says why, naming the target
    expect(() => capture(ctx, 'x', 'lore/digests/new.md')).toThrow(/lore\/digests\/new\.md/);
    // the ordinary targets still work
    expect(capture(ctx, 'kept', 'lore/inbox.md')).toBe('lore/inbox.md');
    expect(capture(ctx, 'kept', 'notes/new.md')).toBe('notes/new.md');
  });

  it('a symlink named .md pointing at a non-note is neither indexed, searched nor readable', async () => {
    // SECURITY.md's top class. Measured on the built product: `ln -s
    // outside/id_rsa vault/leak.md` → `lore index` +1, `lore search zzzsecret`
    // returned the key material, `lore_read_note leak.md` returned it verbatim.
    // Both gates looked at the LINK's name and then followed it.
    const base = await mkdtemp(join(tmpdir(), 'lw-leak-'));
    const root = join(base, 'vault');
    const outside = join(base, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(join(outside, 'shared'), { recursive: true });
    await writeFile(join(root, 'a.md'), '# A\n\nnothing secret here\n');
    await writeFile(join(outside, 'id_rsa'), 'SUPER SECRET PRIVATE KEY material zzzsecret\n');
    await writeFile(join(outside, 'real.md'), '# Real\n\na genuine note, linked in by name\n');
    await writeFile(join(outside, 'shared', 'shared.md'), '# Shared\n\nfolder linked in\n');
    await symlink(join(outside, 'id_rsa'), join(root, 'leak.md'));
    await symlink(join(outside, 'real.md'), join(root, 'linked-note.md'));
    await symlink(join(outside, 'shared'), join(root, 'linked'));

    const paths = (await scanVault(root)).map((f) => f.path);
    expect(paths).not.toContain('leak.md');
    // A link whose target is a genuine note is refused too, now that the
    // boundary is the real vault on the read side as well: the vault owner
    // opts into those in .lore/config.json, and the default is the boundary
    // SECURITY.md describes.
    expect(paths).not.toContain('linked-note.md');
    expect(paths).not.toContain('linked/shared.md');
    expect(paths).toContain('a.md');
    const optedIn = (await scanVault(root, [], { followExternal: true })).map((f) => f.path);
    expect(optedIn).toContain('linked-note.md');
    expect(optedIn).toContain('linked/shared.md');
    expect(optedIn).not.toContain('leak.md');

    const store = openStore(':memory:');
    await indexVault(store, root);
    const notes = (store.db.prepare('SELECT path FROM notes').all() as { path: string }[]).map(
      (r) => r.path,
    );
    expect(notes).not.toContain('leak.md');
    expect(store.searchLexical('zzzsecret', 5)).toEqual([]);
    store.close();

    expect(() => readNoteRaw(root, 'leak.md')).toThrow(/not a readable note/);
    expect(() => readNoteRaw(root, 'linked-note.md')).toThrow(/outside the vault/);
    expect(() => readNoteRaw(root, 'linked/shared.md')).toThrow(/outside the vault/);
    expect(readNoteRaw(root, 'linked-note.md', [], { allowExternal: true })).toContain(
      'genuine note',
    );
  });

  it('scanVault and readNoteRaw agree on every file in a mixed tree', async () => {
    // The property the two previous tests are instances of: the set of paths
    // the scanner indexes IS the set read_note will serve. Built here from
    // every kind of entry a vault can hold, so a future divergence in either
    // direction shows up as a named path.
    const base = await mkdtemp(join(tmpdir(), 'lw-agree-'));
    const root = join(base, 'vault');
    const outside = join(base, 'outside');
    const ignore = ['drafts'];
    for (const d of [
      'sub',
      '.private',
      'node_modules/pkg',
      'drafts',
      'lore/digests',
      'lore/journal',
      '.lore',
    ]) {
      await mkdir(join(root, d), { recursive: true });
    }
    await mkdir(join(outside, 'shared'), { recursive: true });
    const files: Record<string, string> = {
      'a.md': '# A\n',
      'sub/b.md': '# B\n',
      'sub/C.MD': '# C, upper-case extension\n',
      'sub/.hidden.md': 'dotfile\n',
      'sub/notes.txt': 'not markdown\n',
      'sub/README': 'no extension\n',
      '.private/diary.md': 'hidden dir\n',
      'node_modules/pkg/README.md': 'ignored by default\n',
      'drafts/wip.md': 'ignored by config\n',
      'lore/digests/2026-01-01.md': 'derived\n',
      'lore/review-queue.md': 'derived\n',
      'lore/journal/2026-01-01.md': '- [fact] A :: b :: c\n',
      'lore/inbox.md': '- captured\n',
      '.lore/config.json': '{}\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      await writeFile(join(root, rel), content);
    }
    await writeFile(join(outside, 'id_rsa'), 'key material\n');
    await writeFile(join(outside, 'real.md'), '# real\n');
    await writeFile(join(outside, 'shared', 'shared.md'), '# shared\n');
    await writeFile(join(outside, 'shared', '.env'), 'SECRET=1\n');
    await writeFile(join(outside, 'shared', 'creds.json'), '{}\n');
    await symlink(join(outside, 'id_rsa'), join(root, 'leak.md'));
    await symlink(join(outside, 'real.md'), join(root, 'linked-note.md'));
    await symlink(join(outside, 'shared'), join(root, 'linked'));
    await symlink(join(root, 'does-not-exist.md'), join(root, 'dangling.md'));

    const scanned = (await scanVault(root, ignore)).map((f) => f.path).sort();
    const readable: string[] = [];
    for (const rel of await everyFile(root)) {
      try {
        readNoteRaw(root, rel, ignore);
        readable.push(rel);
      } catch {
        /* not served */
      }
    }
    expect(readable).toEqual(scanned);
    // and the set is the one a vault owner would expect
    expect(scanned).toEqual([
      'a.md',
      'lore/inbox.md',
      'lore/journal/2026-01-01.md',
      'sub/C.MD',
      'sub/b.md',
    ]);
  });
});

describe('an index built by a version with the old, looser gate', () => {
  it('drops the rows the current gate would never create, on the next open', async () => {
    // The gate stops NEW leaks; it does nothing about what 0.36.2 already
    // wrote. Measured against the published packages: index a vault with
    // `ln -s ~/.ssh/id_rsa vault/leak.md` under 0.36.2, upgrade to 0.37.0, and
    // `lore search` STILL returns the key material — snippet and all — because
    // ensureIndexed only indexes when the notes table is empty and the
    // incremental indexer only ever revisits files the scan still yields.
    // A user who searches but never runs `lore index` by hand keeps serving
    // the secret forever.
    const base = await mkdtemp(join(tmpdir(), 'lw-stale-'));
    const root = join(base, 'vault');
    const outside = join(base, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, 'real.md'), '# Real\n\nordinary content\n');
    await writeFile(join(outside, 'id_rsa'), 'PRIVATE KEY material zzzstale0001\n');
    await symlink(join(outside, 'id_rsa'), join(root, 'leak.md'));

    const ctx = openContext(root);
    await indexVault(ctx.store, ctx.root);
    // What the old version recorded: the link followed, its content stored.
    ctx.store.upsertNote(parseNote('leak.md', 'PRIVATE KEY material zzzstale0001\n', 1));
    expect(ctx.store.searchLexical('zzzstale0001', 5).length).toBeGreaterThan(0); // precondition

    // The user searches. They never run `lore index`.
    await ensureIndexed(ctx);

    expect(ctx.store.searchLexical('zzzstale0001', 5)).toEqual([]);
    const notes = (ctx.store.db.prepare('SELECT path FROM notes').all() as { path: string }[]).map(
      (r) => r.path,
    );
    expect(notes).not.toContain('leak.md');
    expect(notes).toContain('real.md'); // the genuine note is untouched
    ctx.close();
  });
});

describe('a note that has been deleted since the last index', () => {
  it('is reported as not-a-note rather than throwing, so retrieval survives it', async () => {
    // whyNotNote resolves the real target with realpathSync, which throws ENOENT
    // for a path that is gone. reconcileNoteGate walks every path already in the
    // index, so ONE note deleted or renamed since the last `lore index` made the
    // reconcile throw — and because that reconcile runs from ensureIndexed, every
    // search, and every MCP tool behind it, died with a raw ENOENT naming an
    // absolute path. That is the upgrade path for 0.37.1, where the stamp is
    // absent and the reconcile always runs.
    const base = await mkdtemp(join(tmpdir(), 'lw-gone-'));
    const root = join(base, 'vault');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'kept.md'), '# Kept\n\nherons wade here.\n');

    // a path the index still knows about, whose file is gone
    expect(() => whyNotNote('vanished.md', { root })).not.toThrow();
    expect(whyNotNote('vanished.md', { root })).toMatch(/exist/i);
    // the note that is still there is unaffected
    expect(whyNotNote('kept.md', { root })).toBeNull();
  });
});

