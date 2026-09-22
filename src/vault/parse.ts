import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { Block, Note, WikiLink } from '../types.js';

const MAX_BLOCK_WORDS = 350;
/** ~MAX_BLOCK_WORDS of ordinary English prose, used when words run out. */
const MAX_BLOCK_CHARS = 4000;

export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** Blank out fenced and inline code so links inside code are not parsed. */
function maskCode(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, (m) => ' '.repeat(m.length))
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/**
 * The fence delimiter still open at the end of `text`, starting from `open`.
 * Same delimiter-aware toggle as splitSections: a non-matching marker inside a
 * fence is code, not a close.
 */
function fenceStateAfter(text: string, open: string | null): string | null {
  let cur = open;
  for (const line of text.split('\n')) {
    const m = line.match(/^(```|~~~)/);
    if (!m) continue;
    const marker = m[1]!;
    if (cur === null) cur = marker;
    else if (marker === cur) cur = null;
  }
  return cur;
}

/** Decode %20-style escapes in markdown link targets; tolerate bad encoding. */
function decodeTarget(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Extract links from a text region: `[[wiki links]]` AND relative markdown
 * links to other notes (`[text](../notes/thing.md#heading)`). Most real vaults
 * outside Obsidian use the markdown form exclusively — ignoring it leaves the
 * knowledge graph with almost no edges.
 */
function extractLinks(rawText: string, blockAnchor: string, openFence: string | null = null): WikiLink[] {
  const out: WikiLink[] = [];
  // If this chunk begins inside a fence opened in an earlier chunk, its opening
  // delimiter is gone (chunkText split the fence apart once it exceeded the
  // block-size cap), so maskCode alone cannot blank the leading code. Prepend
  // the missing opener so the code up to its real close is masked — otherwise a
  // [[wikilink]] written inside a large code sample became a real graph edge.
  const text = maskCode(openFence ? `${openFence}\n${rawText}` : rawText);

  // --- markdown links: [alias](target.md#heading) ---
  // Only relative links to .md files (or bare relative paths without a
  // scheme) count as note links; http(s), mailto, images and anchors do not.
  const mdRe = /(!?)\[([^\]\n]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;
  let md: RegExpExecArray | null;
  while ((md = mdRe.exec(text)) !== null) {
    if (md[1] === '!') continue; // image
    const alias = (md[2] ?? '').trim();
    let href = (md[3] ?? '').trim();
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // scheme → external
    if (href.startsWith('#')) continue; // in-page anchor
    let heading: string | undefined;
    const hash = href.indexOf('#');
    if (hash >= 0) {
      heading = decodeTarget(href.slice(hash + 1)).trim() || undefined;
      href = href.slice(0, hash);
    }
    href = decodeTarget(href).replace(/^\.\//, '');
    if (!href) continue;
    if (!/\.md$/i.test(href)) continue; // only markdown note targets
    out.push({
      raw: md[0] ?? '',
      target: href,
      heading,
      alias: alias || undefined,
      blockAnchor,
      style: 'markdown',
    });
  }

  // --- wiki links: [[target]], [[target|alias]], [[target#heading]] ---
  const re = /\[\[([^\[\]]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    let rest = raw;
    let alias: string | undefined;
    const pipe = rest.indexOf('|');
    if (pipe >= 0) {
      alias = rest.slice(pipe + 1).trim() || undefined;
      rest = rest.slice(0, pipe);
    }
    let heading: string | undefined;
    const hash = rest.indexOf('#');
    if (hash >= 0) {
      heading = rest.slice(hash + 1).trim() || undefined;
      rest = rest.slice(0, hash);
    }
    const target = rest.trim();
    if (!target && !heading) continue;
    out.push({ raw, target, heading, alias, blockAnchor, style: 'wiki' });
  }
  return out;
}

/** Inline #tags (not headings, not URL fragments), never from inside code. */
function extractInlineTags(rawText: string, openFence: string | null = null): string[] {
  // Exactly the masking extractLinks applies, and for the same reason: a '#'
  // inside a fence is a hex colour, a C preprocessor directive or a shell
  // comment, not a tag. The two extractors had drifted apart, so a pasted
  // stylesheet made every colour a first-class entity. Prepending the still-open
  // fence delimiter covers a fence chunkText split across blocks; tags carry no
  // offsets, so shifting the string is harmless.
  const text = maskCode(openFence ? `${openFence}\n${rawText}` : rawText);
  const tags = new Set<string>();
  // A tag: '#' preceded by start/whitespace/'(' and followed by a word char;
  // allows letters, digits, -, _, / and unicode letters.
  const re = /(^|[\s(])#([\p{L}\p{N}][\p{L}\p{N}_\/-]*)/gmu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tag = (m[2] ?? '').toLowerCase();
    // pure-numeric "tags" are almost always headings/issue refs, skip
    if (!/^\d+$/.test(tag)) tags.add(tag);
  }
  return [...tags];
}

function normalizeTag(t: unknown): string | null {
  if (typeof t !== 'string' && typeof t !== 'number') return null;
  const s = String(t).trim().replace(/^#/, '').toLowerCase();
  return s ? s : null;
}

interface RawSection {
  headingPath: string[];
  lines: string[];
}

/** Split markdown body into heading-bounded sections (preamble first). */
function splitSections(body: string): RawSection[] {
  const lines = body.split(/\r?\n/);
  const sections: RawSection[] = [{ headingPath: [], lines: [] }];
  const stack: { level: number; title: string }[] = [];
  // The delimiter that opened the current fence, or null. Tracking WHICH
  // delimiter opened it matters: a lone `~~~` inside a ``` block used to flip a
  // single boolean and turn fence state OFF, so `# ...` lines inside the code
  // were parsed as real headings and the prose after the block was mis-filed
  // under a heading that was actually a line of source.
  let fenceMarker: string | null = null;
  for (const line of lines) {
    const m = line.match(/^(```|~~~)/);
    if (m) {
      const marker = m[1]!;
      if (fenceMarker === null) fenceMarker = marker; // open
      else if (marker === fenceMarker) fenceMarker = null; // matching close only
    }
    const inFence = fenceMarker !== null;
    const h = !inFence ? line.match(/^(#{1,6})\s+(.*)$/) : null;
    if (h) {
      const level = (h[1] ?? '').length;
      const title = (h[2] ?? '').trim().replace(/\s+#+\s*$/, '');
      while (stack.length && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      stack.push({ level, title });
      sections.push({ headingPath: stack.map((s) => s.title), lines: [] });
    } else {
      sections[sections.length - 1]!.lines.push(line);
    }
  }
  return sections;
}

/**
 * Split at a character boundary, never inside a surrogate pair — a lone
 * surrogate is not valid UTF-8 and corrupts the text on its way to SQLite.
 */
function hardSplit(s: string): string[] {
  if (s.length <= MAX_BLOCK_CHARS) return [s];
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + MAX_BLOCK_CHARS, s.length);
    const code = s.charCodeAt(end);
    if (end < s.length && code >= 0xdc00 && code <= 0xdfff) end -= 1;
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * Hard-split a single oversized paragraph. Without this, MAX_BLOCK_WORDS is
 * only advisory — a pasted log or CSV with no blank lines becomes one enormous
 * block, and everything downstream (FTS snippets, shingling, embedding)
 * degrades from fast to unusable. Measured before this cap: a 1 MB
 * single-paragraph note made `search` take 30 seconds.
 *
 * The word cap alone is measured in the wrong unit for the very case it exists
 * for. A base64 image, a minified payload, an Excalidraw drawing or a CJK
 * paragraph is ONE "word" that can be megabytes long, so `words.length <= 350`
 * passes and the block stays unbounded. Hence the character cap too.
 */
function splitLongParagraph(p: string): string[] {
  const words = p.split(/\s+/);
  if (words.length <= MAX_BLOCK_WORDS) return hardSplit(p);

  // Split at LINE boundaries, because markdown is line-structured and several
  // consumers read it that way: `- [fact]` lines, Dataview fields, list items.
  // Rejoining words with spaces silently merged them — measured, a note with
  // 60 `- [fact]` lines crossed the word cap and 59 of the facts stopped
  // existing, leaving one whose object was the rest of the list. Under the cap
  // the same note parsed perfectly, so the failure appeared only past a size
  // nobody thinks about.
  const lines = p.split('\n');
  const out: string[] = [];
  let current: string[] = [];
  let count = 0;
  const flush = () => {
    if (current.length) out.push(current.join('\n'));
    current = [];
    count = 0;
  };
  for (const line of lines) {
    const w = line.split(/\s+/).filter(Boolean).length;
    // A single line longer than the whole budget is the only case with no line
    // boundary to use; only there does splitting mid-line remain the option.
    if (w > MAX_BLOCK_WORDS) {
      flush();
      const lw = line.split(/\s+/);
      for (let i = 0; i < lw.length; i += MAX_BLOCK_WORDS) {
        out.push(lw.slice(i, i + MAX_BLOCK_WORDS).join(' '));
      }
      continue;
    }
    if (count > 0 && count + w > MAX_BLOCK_WORDS) flush();
    current.push(line);
    count += w;
  }
  flush();
  return out.flatMap(hardSplit);
}

/** Split section text into ~MAX_BLOCK_WORDS chunks, preferring paragraph borders. */
function chunkText(text: string): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap(splitLongParagraph);
  if (paras.length === 0) return [];
  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;
  let chars = 0;
  for (const p of paras) {
    const w = p.split(/\s+/).length;
    // Both budgets, for the same reason the split above needs both: one
    // hundred 4 000-character wordless paragraphs count as one hundred words
    // and would be merged straight back into the block we just split apart.
    if (words > 0 && (words + w > MAX_BLOCK_WORDS || chars + p.length > MAX_BLOCK_CHARS)) {
      chunks.push(current.join('\n\n'));
      current = [];
      words = 0;
      chars = 0;
    }
    current.push(p);
    words += w;
    chars += p.length;
  }
  if (current.length) chunks.push(current.join('\n\n'));
  return chunks;
}

/**
 * Filenames that describe a file's ROLE in its folder rather than naming a
 * thing. A vault can hold dozens of these, and treating them all as the same
 * title collapses them into one entity and one fact subject — measured on a
 * real corpus, 39 separate `SKILL.md` files produced a single subject whose
 * facts then superseded each other arbitrarily.
 */
const GENERIC_BASENAMES = new Set([
  'readme', 'index', '_index', 'skill', 'home', 'notes', 'note', 'main',
  'overview', 'about', 'summary', 'doc', 'docs', 'contents', 'toc', 'claude',
  'agents', 'default',
]);


/**
 * YAML turns a bare `started: 2025-03-01` into a Date, and the frontmatter is
 * stored as JSON — so by the time anything reads it back it is the string
 * "2025-03-01T00:00:00.000Z", a timestamp with a timezone the user never
 * wrote. Downstream that became the literal object of a fact, so
 * `count --predicate started` grouped by an instant instead of a day.
 *
 * Normalising here rather than at each reader is deliberate: a guard for this
 * already existed in the fact extractor and was dead, because it tested
 * `instanceof Date` on a value JSON had already turned into a string. The
 * index should simply hold what the vault says.
 *
 * A date-only YAML value lands exactly on midnight UTC; anything with a real
 * time component keeps its full ISO form.
 */
function normalizeFrontmatterValue(v: unknown): unknown {
  if (v instanceof Date) {
    if (Number.isNaN(v.valueOf())) return String(v);
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(v)) return v.map(normalizeFrontmatterValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = normalizeFrontmatterValue(val);
    }
    return out;
  }
  return v;
}

/**
 * A note's title: explicit frontmatter wins, then a `name` field, then the
 * filename — except when the filename is generic, in which case the parent
 * folder is what actually identifies it (`skills/writing-skills/SKILL.md`
 * is "writing-skills", not "SKILL").
 */
export function resolveTitle(
  path: string,
  fm: Record<string, unknown>,
  firstHeading?: string,
): string {
  for (const key of ['title', 'name']) {
    const v = fm[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // A vault titled by H1 headings (slug filenames, `# Real Name` inside) is
  // the other common convention besides Obsidian's filename-as-title — and
  // without this fallback every [[Real Name]] link in such a vault resolved
  // to nothing: no note-name seeds, no link expansion, a dead recall
  // channel. The basename is still indexed as a name the note answers to
  // (buildNameIndex), so filename-style links keep working either way.
  if (firstHeading && firstHeading.trim() && !GENERIC_BASENAMES.has(firstHeading.trim().toLowerCase())) {
    return firstHeading.trim();
  }
  const parts = path.split('/');
  const base = (parts.pop() ?? path).replace(/\.md$/i, '');
  if (GENERIC_BASENAMES.has(base.toLowerCase()) && parts.length > 0) {
    const parent = parts[parts.length - 1]!;
    if (parent) return parent;
  }
  return base;
}

/**
 * gray-matter ships a JavaScript frontmatter engine that is a bare `eval`, and
 * selects the engine from the language written after the opening fence — so a
 * note beginning `---js` ran arbitrary code at index time. Vault notes are
 * untrusted (shared vaults, synced folders, notes written by other agents), so
 * that was remote code execution by dropping a markdown file into a folder.
 *
 * Every code-executing engine is replaced with one that throws; parseNote's
 * catch below then degrades the note to empty frontmatter plus a warning, and
 * the fence is stripped so the code is not indexed as prose either. YAML and
 * JSON frontmatter — every real vault — are untouched. Keyed on the canonical
 * names gray-matter aliases to (`js`/`javascript` → javascript; `coffee`/
 * `coffeescript`/`cson` → coffee), so spelling and case do not matter.
 */
const disabledEngine = (name: string) => ({
  parse: (): never => {
    throw new Error(`${name} frontmatter is disabled: it would execute code from the note`);
  },
  stringify: (): never => {
    throw new Error(`${name} frontmatter is disabled`);
  },
});
const INERT_ENGINES = {
  javascript: disabledEngine('JavaScript'),
  coffee: disabledEngine('CoffeeScript'),
};

/**
 * Parse one markdown file into a Note. Never throws on malformed input:
 * frontmatter errors degrade to empty frontmatter + a warning.
 */
export function parseNote(path: string, raw: string, mtimeMs: number, size?: number): Note {
  const warnings: string[] = [];
  let fm: Record<string, unknown> = {};
  let body = raw;
  try {
    const parsed = matter(raw, { engines: INERT_ENGINES });
    fm = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch (err) {
    warnings.push(`frontmatter parse failed: ${(err as Error).message}`);
    // strip the bad frontmatter fence so it doesn't pollute blocks — including
    // a fence that names a language (`---js`), which the plain form missed
    body = raw.replace(/^---[A-Za-z]*\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  }

  // tags: frontmatter (string | array) + inline
  const tagSet = new Set<string>();
  const fmTags = fm.tags ?? fm.tag;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      const n = normalizeTag(t);
      if (n) tagSet.add(n);
    }
  } else if (typeof fmTags === 'string') {
    for (const t of fmTags.split(/[,\s]+/)) {
      const n = normalizeTag(t);
      if (n) tagSet.add(n);
    }
  }

  const sections = splitSections(body);
  const firstHeading = sections.find((s) => s.headingPath.length === 1)?.headingPath[0];
  const title = resolveTitle(path, fm, firstHeading);
  const blocks: Block[] = [];
  const links: WikiLink[] = [];
  const anchorCounts = new Map<string, number>();
  let order = 0;
  for (const sec of sections) {
    const headingKey = sec.headingPath.join('/');
    let chunks = chunkText(sec.lines.join('\n'));
    // A heading with no body IS the content. Stub notes (created by following
    // a link) and index/MOC notes are often nothing but headings; without
    // this they produced zero blocks and were entirely unsearchable — a note
    // titled "Quokka Protocol" could not be found by searching for it.
    if (chunks.length === 0 && sec.headingPath.length > 0) {
      chunks = [sec.headingPath[sec.headingPath.length - 1] ?? ''];
    }
    // A fence never spans a section boundary (a heading inside a fence is not a
    // heading — see splitSections), so fence state resets per section. It CAN
    // span chunk boundaries within a section, which is what this carries.
    let openFence: string | null = null;
    for (const chunk of chunks) {
      if (!chunk) continue;
      const seq = anchorCounts.get(headingKey) ?? 0;
      anchorCounts.set(headingKey, seq + 1);
      const anchor = `${headingKey}@${seq}`;
      blocks.push({
        anchor,
        heading: headingKey,
        order: order++,
        text: chunk,
        hash: sha1(chunk),
      });
      links.push(...extractLinks(chunk, anchor, openFence));
      for (const t of extractInlineTags(chunk, openFence)) tagSet.add(t);
      openFence = fenceStateAfter(chunk, openFence);
    }
    // heading-only sections still contribute their heading as context for
    // link extraction in the heading line itself (rare, skip otherwise)
  }

  // A note whose entire content is frontmatter — a metadata record, a
  // dataview-style entry, a template stub — otherwise produced no blocks and
  // could not be found by its own title.
  if (blocks.length === 0) {
    const parts = [title];
    for (const [k, v] of Object.entries(fm)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`${k}: ${v}`);
      } else if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === 'string' || typeof item === 'number') parts.push(String(item));
        }
      }
    }
    const text = parts.filter(Boolean).join(' · ').trim();
    if (text) {
      blocks.push({ anchor: '@0', heading: '', order: 0, text, hash: sha1(text) });
    }
  }

  return {
    path,
    title,
    frontmatter: normalizeFrontmatterValue(fm) as Record<string, unknown>,
    tags: [...tagSet],
    links,
    blocks,
    hash: sha1(raw),
    mtimeMs,
    size: size ?? Buffer.byteLength(raw, 'utf8'),
    warnings,
  };
}

/**
 * True when a block's text is only an echo of its own heading.
 *
 * A section with no body of its own is indexed as its heading so that a note
 * made only of headings can still be found. That text is a stand-in for
 * findability — nobody wrote it — and section names ("Overview", "Usage",
 * "The Process") repeat constantly across a vault, so anything that treats
 * block text as authored content must skip these or it will conclude that two
 * unrelated notes say the same thing. They stay indexed and searchable; the
 * lexical index is what they exist for.
 *
 * Shared by every such consumer on purpose: two copies of this rule would
 * drift, and the failures it prevents are silent ones.
 */
export function isHeadingEcho(heading: string, text: string): boolean {
  const leaf = (heading.split('/').pop() ?? '').trim();
  return leaf !== '' && text.trim() === leaf;
}
