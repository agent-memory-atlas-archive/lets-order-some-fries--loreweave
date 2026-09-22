import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { capture, readNoteRaw, safeVaultPath } from '../src/capture.js';
import { openStore } from '../src/store/db.js';
import { ConfigSchema } from '../src/config.js';

/** capture now self-indexes its write, so it needs a real store and config. */
function miniCtx(root: string) {
  return {
    root,
    config: ConfigSchema.parse({}),
    store: openStore(':memory:'),
  } as never;
}

/**
 * `resolve` normalises `..` but does not follow symlinks, so containment was
 * enforced lexically: `../secret.md` was refused while `linked/secret.md`,
 * through a symlinked folder, went straight through. Both of these paths are
 * driven by an agent over MCP.
 */
async function vaultWithSymlink() {
  const base = await mkdtemp(join(tmpdir(), 'lw-esc-'));
  const vault = join(base, 'vault');
  const outside = join(base, 'outside');
  await mkdir(vault, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.md'), '# Secret\n\nOutside the vault.\n');
  await writeFile(join(outside, 'target.md'), 'original\n');
  await symlink(outside, join(vault, 'linked'));
  return { vault, outside };
}

describe('vault containment', () => {
  it('refuses plain traversal', async () => {
    const { vault } = await vaultWithSymlink();
    expect(() => readNoteRaw(vault, '../outside/secret.md')).toThrow(/escapes the vault/);
  });

  it('refuses a note whose real file is outside the vault, unless the owner opted in', async () => {
    // The read side used to allow this, because the scanner indexed those
    // notes and a search result nothing can open is worse than none. The
    // scanner stopped following a link out of the vault, so that rationale is
    // gone and the read follows it out again — with .lore/config.json, which
    // vault content cannot write, as the one way to say otherwise.
    const { vault } = await vaultWithSymlink();
    expect(() => readNoteRaw(vault, 'linked/secret.md')).toThrow(/outside the vault/);
    expect(readNoteRaw(vault, 'linked/secret.md', [], { allowExternal: true })).toContain(
      'Outside the vault',
    );
  });

  it('refuses to read anything that is not a note, even through a symlink', async () => {
    // The symlink exemption above exists so INDEXED NOTES stay openable. The
    // vault scanner indexes non-dotfile .md and nothing else, so anything else
    // reachable through that symlink was never a note and was never in an
    // answer — but read_note returned it anyway: a .env, an SSH private key
    // and a credentials JSON all came back in full over MCP. SECURITY.md names
    // "the CLI or MCP server reading files outside the vault it was pointed at"
    // as a highest-priority bug, and a prompt injection in any indexed note is
    // enough to steer an agent into asking for one.
    const { vault, outside } = await vaultWithSymlink();
    await writeFile(join(outside, '.env'), 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI\n');
    await writeFile(join(outside, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\n');
    await mkdir(join(outside, 'nested'), { recursive: true });
    await writeFile(join(outside, 'nested', 'creds.json'), '{"token":"ghp_secret"}\n');

    for (const rel of ['linked/.env', 'linked/id_ed25519', 'linked/nested/creds.json']) {
      expect(() => readNoteRaw(vault, rel)).toThrow(/not a readable note/);
    }
    // Same rule applies without a symlink in the way.
    await writeFile(join(vault, '.env'), 'SECRET=1\n');
    expect(() => readNoteRaw(vault, '.env')).toThrow(/not a readable note/);
  });

  it('refuses to WRITE through a symlink', async () => {
    // Linking a folder in so its notes can be found does not ask the engine to
    // create files inside it. Before this, capture appended to a file outside
    // the vault and reported success.
    const { vault, outside } = await vaultWithSymlink();
    expect(() => capture(miniCtx(vault), 'INJECTED', 'linked/target.md')).toThrow(/symlink/);
    expect(await readFile(join(outside, 'target.md'), 'utf8')).toBe('original\n');
  });

  it('still writes normally inside the vault', async () => {
    const { vault } = await vaultWithSymlink();
    expect(capture(miniCtx(vault), 'a real note', 'lore/inbox.md')).toBe('lore/inbox.md');
    expect(await readFile(join(vault, 'lore', 'inbox.md'), 'utf8')).toContain('a real note');
  });

  it('write containment covers paths that do not exist yet', async () => {
    // capture creates its target, so the check has to run on the deepest
    // ancestor that exists rather than on the file itself.
    const { vault } = await vaultWithSymlink();
    expect(() =>
      safeVaultPath(vault, 'linked/new/deep/note.md', { followSymlinks: false }),
    ).toThrow(/symlink/);
    // Compare against the platform's own resolver: the returned path is an
    // absolute filesystem path, so on Windows it carries backslashes and a
    // POSIX-substring assertion fails on separators, not on containment.
    expect(safeVaultPath(vault, 'notes/new/deep/note.md', { followSymlinks: false })).toBe(
      resolve(vault, 'notes/new/deep/note.md'),
    );
  });
});
