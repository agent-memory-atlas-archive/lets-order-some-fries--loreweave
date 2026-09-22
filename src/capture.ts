import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { LoreContext } from './context.js';
import { indexNoteFile } from './index/indexer.js';
import { decodeNote } from './vault/read.js';
import { whyNotNote } from './vault/scan.js';

/** Deepest ancestor of `abs` that exists, with symlinks resolved. */
function realExistingAncestor(abs: string): { real: string; tail: string[] } {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return { real: realpathSync(cur), tail };
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return { real: cur, tail }; // reached the filesystem root
      tail.unshift(cur.slice(parent.length + 1));
      cur = parent;
    }
  }
}

/**
 * Resolve a vault-relative path, refusing traversal outside the vault.
 *
 * `resolve` normalises `..` but does NOT follow symlinks, so the check was
 * lexical only: `../secret.md` was refused while `linked/secret.md`, through a
 * symlinked folder, was allowed straight through. Both paths here are driven
 * by an agent over MCP, so the difference is not academic.
 *
 * Reads and writes get different answers on purpose.
 *
 * `scanVault` follows symlinked folders deliberately — a folder symlinked into
 * a vault used to be silently invisible, which was its own bug — so those
 * notes are indexed, are returned by search, and must be readable. Refusing to
 * read them would leave search returning results that cannot be opened.
 *
 * Writing is not implied by any of that. Linking a folder in so its notes can
 * be found does not ask the engine to create files inside it, so writes are
 * held to the real vault root: symlinks resolved, no exceptions.
 */
export function safeVaultPath(
  root: string,
  rel: string,
  opts: { followSymlinks?: boolean } = {},
): string {
  const abs = resolve(root, rel);
  const rootAbs = resolve(root);
  const inside = (p: string, r: string) => p === r || p.startsWith(r + sep);
  if (!inside(abs, rootAbs)) {
    throw new Error(`path escapes the vault: ${rel}`);
  }
  if (opts.followSymlinks === false) {
    // The target may not exist yet (capture creates it), so containment is
    // checked on the deepest ancestor that does; the rest cannot be a symlink
    // because it is not there.
    const rootReal = realExistingAncestor(rootAbs).real;
    const { real, tail } = realExistingAncestor(abs);
    const resolved = tail.length ? join(real, ...tail) : real;
    if (!inside(resolved, rootReal)) {
      throw new Error(`path escapes the vault through a symlink: ${rel}`);
    }
  }
  return abs;
}

/**
 * Quick capture: append a timestamped bullet to lore/inbox.md (or another
 * vault note). Append-only — the engine never rewrites user prose.
 */
export function capture(ctx: LoreContext, text: string, to = 'lore/inbox.md'): string {
  const clean = text.trim();
  if (!clean) throw new Error('nothing to capture');
  ctx.store.assertWritable(); // before the append: a captured line the index cannot see is a lost line
  // Writes never leave the real vault, even through a symlink the user put
  // there for reading.
  const abs = safeVaultPath(ctx.root, to, { followSymlinks: false });
  // Only where the scanner will look. A capture into `.lore/`, `node_modules/`
  // or `lore/digests/` used to report success and be searchable — until the
  // next index, which never sees those paths and so deleted the note as
  // gone. Lexical only: the target may not exist yet, and the symlink case
  // is already settled above.
  const reason = whyNotNote(to, { ignore: ctx.config.ignore });
  if (reason !== null) {
    throw new Error(`capture target would never be indexed (${reason}): ${to}`);
  }
  mkdirSync(dirname(abs), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  appendFileSync(abs, `- ${stamp} — ${clean.replace(/\r?\n+/g, ' ')}\n`, 'utf8');
  // Index what was just written, so "capture, then search for it" works. The
  // trap this removes was real enough to have been documented in the MCP tool
  // description as something the caller had to remember.
  indexNoteFile(ctx.store, ctx.root, to, { nlp: ctx.config.nlp });
  ctx.invalidateGraph?.();
  return to;
}

/**
 * Read a note's raw markdown (path-validated).
 *
 * Exactly the files the vault scanner would index are readable — the one
 * definition lives in vault/scan.ts (`whyNotNote`), and this is a caller of
 * it, not a second copy. Reading a note reached through a symlinked folder is
 * deliberate, but only while that folder's real location is inside the vault:
 * the scanner no longer follows a link that leaves it, so refusing the read
 * strands no search result. That was the whole of the old exemption's
 * rationale, and it now points the other way. A vault owner who means it can
 * set `followExternalSymlinks` in .lore/config.json — a file vault content
 * cannot write. The rest of the gate covered NOTES only. The
 * gate before this one checked the basename of the path it was GIVEN, which
 * let through two things the scanner never indexes: a note inside a hidden
 * or ignored directory (`.private/diary.md`), and a symlink named `x.md`
 * whose target is `~/.ssh/id_rsa`. The resolved-target clause closes the
 * second; the per-segment clause closes the first.
 *
 * `ignore` is the vault's config.ignore, so a folder the scanner skips on
 * the user's instruction is skipped here too.
 */
export function readNoteRaw(
  root: string,
  rel: string,
  ignore: string[] = [],
  opts: { allowExternal?: boolean } = {},
): string {
  // Containment first, so a traversal attempt is still reported as one rather
  // than as a file-type complaint.
  const abs = safeVaultPath(root, rel);
  const reason = whyNotNote(rel, { ignore, root, allowExternal: opts.allowExternal });
  if (reason !== null) {
    throw new Error(`not a readable note (${reason}): ${rel}`);
  }
  // Decoded the way the indexer decodes it, so a UTF-16 note reads as its
  // text over MCP rather than as the U+FFFD-and-NUL string it indexed as.
  return decodeNote(readFileSync(abs)).text;
}
