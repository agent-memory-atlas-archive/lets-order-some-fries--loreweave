import type { Note } from '../types.js';

/**
 * Deterministic fact extraction — no LLM, no network.
 *
 * The bitemporal fact layer is the product's headline feature, but nothing
 * populated it: measured on a real vault, `facts: 0`. Nobody writes
 * `- [fact] X :: y :: z` by hand.
 *
 * Real vaults state facts in four recognisable shapes, all handled here:
 *
 *   frontmatter      status: active
 *   bold label       - **Location:** Hyderabad, India
 *   inline field     - location:: Hyderabad          (Dataview convention)
 *   observation      - [location] Hyderabad          (Basic Memory convention)
 *
 * The subject is the note itself — a note titled "Project Atlas" containing
 * `status: shipped` is asserting that Atlas is shipped. Anything ambiguous is
 * skipped: over-extraction poisons the fact store, and a missed fact merely
 * leaves it where it already was.
 */

/**
 * Which syntaxes to mine.
 *
 * `explicit` covers forms where the author unambiguously declared a field —
 * frontmatter, Dataview `key:: value`, Basic Memory `- [key] value`.
 * `prose` adds `- **Key:** value` and `- Key: value`, which are ordinary
 * formatting: precise on entity notes ("- **Location:** Hyderabad") and noisy
 * on report notes ("- **Moat:** continuously-generated scan corpus"). Prose
 * mining is therefore opt-in.
 */
export type ExtractionMode = 'explicit' | 'all' | 'off';

export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  blockAnchor: string;
  /** ISO date when frontmatter/text supplied one. */
  validFrom?: string;
  /**
   * ISO date the line's own `{valid_until=…}` closed the fact on.
   *
   * It was computed below and spread into the result long before it was
   * declared here, and an undeclared property is an invisible one: the
   * extracted-fact INSERT wrote a literal NULL into that column and no
   * typecheck could say it had dropped anything.
   */
  validUntil?: string;
  confidence: number;
}

/** Frontmatter keys that describe the FILE, not the thing it is about. */
const META_KEYS = new Set([
  'title', 'tags', 'tag', 'aliases', 'alias', 'cssclass', 'cssclasses',
  'publish', 'permalink', 'draft', 'layout', 'template', 'id', 'uid',
  'created', 'updated', 'modified', 'date', 'description', 'summary',
  'excerpt', 'image', 'cover', 'banner', 'weight', 'order', 'toc',
]);

const MAX_PREDICATE = 40;
const MAX_OBJECT = 300;

/** Field names must look like field names, not sentence fragments. */
function plausiblePredicate(key: string): boolean {
  const k = key.trim();
  if (!k || k.length > MAX_PREDICATE) return false;
  if (META_KEYS.has(k.toLowerCase())) return false;
  if (/[.!?]$/.test(k)) return false;
  // at most three words: "status", "reports to", "primary contact"
  if (k.split(/\s+/).length > 3) return false;
  return /[\p{L}]/u.test(k);
}

function plausibleObject(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > MAX_OBJECT) return false;
  // a full sentence is prose, not a field value
  if (/[.!?]\s+\p{Lu}/u.test(v)) return false;
  if (v.split(/\s+/).length > 25) return false;
  return true;
}

/** Strip markdown emphasis/links so the value is the plain text. */
/**
 * Split a trailing `{key=value, key=value}` block off a fact's object.
 *
 * Same syntax the journal emits, so a hand-written line and a generated one
 * mean the same thing. Values may be quoted; an unparseable block is left
 * alone rather than guessed at.
 */
function splitTrailingAttrs(raw: string): { object: string; attrs: Record<string, string> } {
  const m = raw.match(/\{([^{}]*)\}\s*$/);
  if (!m) return { object: raw, attrs: {} };
  const attrs: Record<string, string> = {};
  for (const part of (m[1] ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim().toLowerCase().replace(/[\s-]+/g, '_');
    const v = part.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k) attrs[k] = v;
  }
  if (Object.keys(attrs).length === 0) return { object: raw, attrs: {} };
  return { object: raw.slice(0, m.index).trim(), attrs };
}

function cleanValue(v: string): string {
  return v
    .replace(/\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g, (_m, t: string, a?: string) => a ?? t)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,;]$/, '');
}

/**
 * Accept a date OR a datetime and return the date part.
 *
 * gray-matter parses `date: 2026-01-15` into a Date, which JSON storage
 * serialises to "2026-01-15T00:00:00.000Z". A date-only regex silently
 * rejected that, so every extracted fact lost its valid_from and `--as-of`
 * could not see it.
 */
function asIsoDate(v: string | null): string | null {
  if (!v) return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/);
  return m ? m[1]! : null;
}

function scalar(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date && !Number.isNaN(v.valueOf())) return v.toISOString().slice(0, 10);
  return null;
}

/**
 * Extract facts from one note. `subject` is the note's title for every fact;
 * provenance (block anchor) is preserved so each fact points at its source.
 */
export function extractFactsFromNote(
  note: Note,
  mode: ExtractionMode = 'explicit',
): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  if (mode === 'off') return out;
  const subject = note.title;
  if (!subject) return out;

  const seen = new Set<string>();
  const subjectKey = subject.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const push = (predicate: string, rawObject: string, blockAnchor: string, confidence: number) => {
    const p = predicate.trim().replace(/[:*_`]+$/, '').trim();
    // A trailing `{valid_from=…}` is this project's own metadata syntax — the
    // journal writes it on every line it emits. Only the `- [fact]` form used
    // to read it, so on any other form the braces were swallowed whole into
    // the object: the user's date was lost AND it corrupted the value, giving
    // `status :: shipped {valid_from=2026-07-15}` as a literal object string.
    const { object: stripped, attrs } = splitTrailingAttrs(rawObject);
    const o = cleanValue(stripped);
    if (!plausiblePredicate(p) || !plausibleObject(o)) return;
    // "writing-skills :: name :: writing-skills" states nothing. A fact whose
    // object merely repeats its subject is noise in every view it appears in.
    if (o.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === subjectKey) return;
    const key = `${p.toLowerCase()}|${o.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const from = attrs.valid_from ? asIsoDate(attrs.valid_from) : null;
    const until = attrs.valid_until ? asIsoDate(attrs.valid_until) : null;
    const conf = attrs.confidence ? Number(attrs.confidence) : NaN;
    out.push({
      subject,
      predicate: p,
      object: o,
      blockAnchor,
      confidence: Number.isFinite(conf) && conf > 0 && conf <= 1 ? conf : confidence,
      ...(from ? { validFrom: from } : {}),
      ...(until ? { validUntil: until } : {}),
    });
  };

  // A date in frontmatter dates the whole note's assertions.
  let validFrom: string | undefined;
  for (const k of ['valid_from', 'date', 'created']) {
    const v = asIsoDate(scalar(note.frontmatter[k]));
    if (v) {
      validFrom = v;
      break;
    }
  }

  // tier 1 — frontmatter scalars
  for (const [k, v] of Object.entries(note.frontmatter)) {
    const s = scalar(v);
    if (s !== null) {
      push(k, s, '', 0.95);
      continue;
    }
    // a short list of scalars becomes one fact per entry
    if (Array.isArray(v) && v.length <= 10 && !META_KEYS.has(k.toLowerCase())) {
      for (const item of v) {
        const si = scalar(item);
        if (si !== null) push(k, si, '', 0.9);
      }
    }
  }

  // tiers 2-4 — list-item conventions inside block text
  for (const b of note.blocks) {
    let inFence = false;
    for (const line of b.text.split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const item = line.match(/^\s*[-*+]\s+(.*)$/);
      if (!item) {
        // A bare `key:: value` line. Dataview's inline fields are written this
        // way at least as often as inside a list, so only reading the list
        // form silently ignored half of the convention we claim to support.
        //
        // The space after `::` is what makes this safe: `std::vector`,
        // `Foo::bar` and every other scope operator in every language has no
        // space, so requiring one separates a field from code without needing
        // to know the language. Fenced blocks are skipped outright anyway.
        const bare = line.match(/^([\p{L}][\p{L}\p{N} _/-]{0,38})::[ \t]+(\S.*)$/u);
        if (bare) push(bare[1]!, bare[2]!, b.anchor, 0.9);
        continue;
      }
      const body = (item[1] ?? '').trim();
      if (!body) continue;

      // - [fact] / - [invalidate] are handled by the journal parser
      if (/^\[(fact|invalidate)\]/i.test(body)) continue;

      // - [ ] / - [x] are task list items, not observations. Without this a
      // PR template checklist ("- [x] Bug fix") became the fact
      // `note :: x :: Bug fix`.
      if (/^\[[ xX]?\]/.test(body)) continue;
      // - [key] value   (Basic Memory observation)
      const obs = body.match(/^\[([^\]]{2,40})\]\s+(.+)$/);
      if (obs && /[\p{L}]{2}/u.test(obs[1]!)) {
        push(obs[1]!, obs[2]!, b.anchor, 0.85);
        continue;
      }
      // - key:: value   (Dataview inline field)
      const dv = body.match(/^([^:]{1,40})::\s*(.+)$/);
      if (dv) {
        push(dv[1]!, dv[2]!, b.anchor, 0.9);
        continue;
      }
      if (mode !== 'all') continue;
      // - **Key:** value   (bold label — precise on entity notes, noisy on
      // report notes, hence gated behind mode='all')
      const bold = body.match(/^\*\*([^*]{1,40}?):?\*\*:?\s*(.+)$/);
      if (bold) {
        push(bold[1]!, bold[2]!, b.anchor, 0.8);
        continue;
      }
      // - Key: value  — only when the key is short and unambiguous, or this
      // would swallow ordinary prose containing a colon.
      const plain = body.match(/^([\p{L}][\p{L}\p{N} _-]{1,28}):\s+(.+)$/u);
      if (plain && plain[1]!.split(/\s+/).length <= 2) {
        push(plain[1]!, plain[2]!, b.anchor, 0.7);
      }
    }
  }

  if (validFrom) for (const f of out) f.validFrom = validFrom;
  return out;
}
