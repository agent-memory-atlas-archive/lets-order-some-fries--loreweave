import { readdir, realpath, stat } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { VaultFile } from '../types.js';

const DEFAULT_IGNORES = new Set(['node_modules', '.git', '.obsidian', '.lore', '.trash']);

/**
 * Engine-generated notes under `lore/` that must never be indexed, or the
 * engine's own output becomes its own input: a review queue listing orphans
 * makes those orphans look linked, and digests compete with real notes in
 * search. Journals are the exception — they are the durable fact record and
 * MUST be read back.
 */
const DERIVED_PREFIXES = ['lore/digests/', 'lore/review-queue'];

export function isDerivedNote(path: string): boolean {
  return DERIVED_PREFIXES.some((p) => path.startsWith(p));
}

/** The basename rule, shared by the lexical and the resolved check. */
function isNoteBasename(name: string): boolean {
  return /\.md$/i.test(name) && !name.startsWith('.');
}

export interface NoteCheck {
  /** Extra directory names to skip, on top of the defaults (config.ignore). */
  ignore?: string[];
  /**
   * When set, `rel` is also resolved against this vault root and the REAL
   * file behind it — symlinks followed — must itself be a regular `.md` file.
   * Reading and indexing want this; a write to a path that does not exist
   * yet cannot.
   */
  root?: string;
  /**
   * Allow a note whose real file lives outside the vault (config
   * `followExternalSymlinks`). Off by default: see the boundary note below.
   */
  allowExternal?: boolean;
}

/**
 * The real vault root, cached per root string.
 *
 * Every note check inside one scan resolves against it, and the vault root
 * does not move under a running process. Without the cache this is one extra
 * realpath syscall per file on every scan.
 */
const realRoots = new Map<string, string>();
function realVaultRoot(root: string): string {
  let r = realRoots.get(root);
  if (r === undefined) {
    try {
      r = realpathSync(root);
    } catch {
      r = resolve(root);
    }
    realRoots.set(root, r);
  }
  return r;
}

/** Containment on real paths — both sides already resolved. */
export function insideRealRoot(real: string, rootReal: string): boolean {
  return real === rootReal || real.startsWith(rootReal + sep);
}

/**
 * Why a vault-relative path is not a note, or null when it is one.
 *
 * This is the single definition of "note" for the engine. The scanner, the
 * MCP `read_note` tool and `capture` each used to carry their own, and the
 * three disagreed in ways that all leaked something:
 *
 * - `read_note` checked only the basename, so `.private/diary.md`,
 *   `node_modules/pkg/README.md` and `.lore/notes.md` — none of which the
 *   scanner ever indexes — were handed back in full on request.
 * - The scanner and `read_note` both gated on the LINK's name, so a symlink
 *   called `leak.md` pointing at `~/.ssh/id_rsa` was indexed, returned by
 *   search and served verbatim. SECURITY.md's highest-priority class.
 * - `capture` wrote into `.lore/`, `node_modules/` and `lore/digests/`,
 *   reported success, and the next index deleted the note.
 *
 * A path is a note iff no directory segment starts with `.` or is in the
 * ignore set, it is not under a derived prefix, its basename is a non-dotfile
 * `.md`, and — when `root` is given — the resolved target is a regular file
 * whose own basename is a non-dotfile `.md`. The last clause is what keeps a
 * symlinked FOLDER of genuine notes indexable (the real file is `x.md`) while
 * refusing a symlink whose target is anything else.
 */
export function whyNotNote(rel: string, opts: NoteCheck = {}): string | null {
  const ignoreSet = new Set([...DEFAULT_IGNORES, ...(opts.ignore ?? [])]);
  const segments = rel.split(/[\\/]/);
  const name = segments[segments.length - 1] ?? '';
  for (const dir of segments.slice(0, -1)) {
    if (dir.startsWith('.')) return `inside a hidden directory (${dir})`;
    if (ignoreSet.has(dir)) return `inside an ignored directory (${dir})`;
  }
  if (!/\.md$/i.test(name)) return 'vault notes are .md files';
  if (name.startsWith('.')) return 'dotfiles are not notes';
  if (isDerivedNote(segments.join('/'))) return 'engine-generated (lore/digests, review queue)';
  if (opts.root !== undefined) {
    // realpath follows every link in the chain; whatever it lands on is what
    // would actually be read, so that is what has to be a note.
    // A path that cannot be resolved is not a note — it is not an error. The
    // index outlives the files it describes: reconcileNoteGate walks the paths
    // already stored, so one note deleted or renamed since the last index threw
    // ENOENT out of every retrieval, and over MCP that surfaced as a raw errno
    // carrying the vault's absolute path.
    let real: string;
    try {
      real = realpathSync(join(opts.root, rel));
      if (!statSync(real).isFile()) return 'not a regular file';
    } catch {
      return 'no longer exists in the vault';
    }
    if (!isNoteBasename(basename(real))) return `resolves to ${basename(real)}, which is not a note`;
    // The boundary is the REAL vault, on the read side as well as the write
    // side. A symlink named like a note, or a whole folder linked in, is a
    // path someone who can write one file into the vault chooses for the
    // indexer to read, search to return and lore_read_note to serve in full —
    // and SECURITY.md's first-priority class is "the CLI or MCP server
    // reading files outside the vault it was pointed at". Reading these was
    // allowed because the scanner indexed them, and refusing the read alone
    // would have left search returning results nothing could open; the
    // scanner no longer yields them, so the two agree again.
    if (opts.allowExternal !== true && !insideRealRoot(real, realVaultRoot(opts.root))) {
      return 'resolves outside the vault';
    }
  }
  return null;
}

export function isNotePath(rel: string, opts: NoteCheck = {}): boolean {
  return whyNotNote(rel, opts) === null;
}

/**
 * Recursively find markdown files under `root`.
 * Skips dot-directories and DEFAULT_IGNORES; extra names via `ignore`.
 * Returns vault-relative forward-slash paths, sorted for determinism.
 */
export async function scanVault(
  root: string,
  ignore: string[] = [],
  opts: { followSymlinks?: boolean; followExternal?: boolean } = {},
): Promise<VaultFile[]> {
  const ignoreSet = new Set([...DEFAULT_IGNORES, ...ignore]);
  const follow = opts.followSymlinks !== false;
  // A link that stays inside the vault is followed as it always was; one that
  // leaves it is not a note unless the vault's own config says so.
  const external = opts.followExternal === true;
  const rootReal = realVaultRoot(root);
  const out: VaultFile[] = [];
  // Real paths already walked. A symlinked directory pointing at an ancestor
  // is an infinite tree; following links without this would never terminate.
  const visited = new Set<string>();

  async function walk(dir: string, rel: string): Promise<void> {
    if (follow) {
      let real: string;
      try {
        real = await realpath(dir);
      } catch {
        return; // broken link or vanished directory
      }
      if (visited.has(real)) return;
      visited.add(real);
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: skip, not fatal
    }
    for (const e of entries) {
      const name = e.name;
      // A symlink reports as neither file nor directory, so without this a
      // folder symlinked into the vault was silently skipped — the notes were
      // simply invisible, with nothing to indicate why.
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      const isLink = e.isSymbolicLink();
      if (follow && isLink) {
        try {
          const st = await stat(join(dir, name)); // follows the link
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // dangling link
        }
      }
      if (isDir) {
        if (name.startsWith('.') || ignoreSet.has(name)) continue;
        if (isLink && !external) {
          try {
            if (!insideRealRoot(await realpath(join(dir, name)), rootReal)) continue;
          } catch {
            continue;
          }
        }
        await walk(join(dir, name), rel ? `${rel}/${name}` : name);
      } else if (isFile) {
        const relPath = rel ? `${rel}/${name}` : name;
        if (whyNotNote(relPath, { ignore }) !== null) continue;
        const abs = join(dir, name);
        // A regular entry's name IS its real name, and so is that of a file
        // inside a symlinked folder. Only a symlinked FILE can be called one
        // thing and be another, so only there is the target resolved.
        if (isLink) {
          try {
            const real = await realpath(abs);
            if (!isNoteBasename(basename(real))) continue;
            if (!external && !insideRealRoot(real, rootReal)) continue;
          } catch {
            continue;
          }
        }
        try {
          const s = await stat(abs);
          out.push({
            path: relPath,
            absPath: abs,
            mtimeMs: s.mtimeMs,
            size: s.size,
          });
        } catch {
          // raced deletion: skip
        }
      }
    }
  }

  await walk(root, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
