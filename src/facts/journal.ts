/**
 * Fact lines in markdown are the durable record; DB fact rows are a replay.
 *
 *   - [fact] Subject :: predicate :: Object {valid_from=2026-08-05, confidence=0.9}
 *   - [invalidate] Subject :: predicate {valid_until=2026-08-10}
 *
 * Facts may appear in any note (source_type 'extracted'); the engine's own
 * assertions are appended to lore/journal/YYYY-MM-DD.md (source_type from the
 * line's `source` attr, default 'stated'). Rebuild wipes and replays ALL fact
 * rows deterministically, so the index stays a pure cache of the vault.
 */
import type { Store } from '../store/db.js';
import type { Note } from '../types.js';
import { normalizeKey } from '../normalize.js';
import { extractFactsFromNote, type ExtractionMode } from './extract.js';

export const JOURNAL_DIR = 'lore/journal';

export function isJournalPath(path: string): boolean {
  return path.startsWith(`${JOURNAL_DIR}/`);
}

export interface FactLine {
  kind: 'fact' | 'invalidate';
  subject: string;
  predicate: string;
  object?: string;
  attrs: Record<string, string>;
}

const FACT_RE = /^\s*[-*+]\s*\[(fact|invalidate)\]\s*(.+)$/;

/**
 * The journal is line-based, so control characters must be escaped or a fact
 * containing a newline would be silently truncated on replay (data loss).
 * Escaping is lossless and round-trips through `unescapeField`.
 */
export function escapeField(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    // The field delimiter itself must be escaped, or a subject/predicate
    // containing '::' re-parses into different fields on replay.
    .replace(/::/g, '\\:\\:');
}

export function unescapeField(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === 'n') {
        out += '\n';
        i++;
        continue;
      }
      if (next === 'r') {
        out += '\r';
        i++;
        continue;
      }
      if (next === '\\') {
        out += '\\';
        i++;
        continue;
      }
      if (next === ':') {
        out += ':';
        i++;
        continue;
      }
    }
    out += s[i];
  }
  return out;
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const part of s.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) attrs[k] = v;
  }
  return attrs;
}

/** Parse all fact lines in a block of text (order preserved). */
export function parseFactLines(text: string): FactLine[] {
  const out: FactLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(FACT_RE);
    if (!m) continue;
    const kind = m[1] as 'fact' | 'invalidate';
    let body = (m[2] ?? '').trim();
    let attrs: Record<string, string> = {};
    const attrMatch = body.match(/\{([^{}]*)\}\s*$/);
    if (attrMatch) {
      attrs = parseAttrs(attrMatch[1] ?? '');
      body = body.slice(0, attrMatch.index).trim();
    }
    // Split on the FIRST two '::' only; the object keeps everything after
    // (verbatim), so objects may legitimately contain '::'.
    const i1 = body.indexOf('::');
    if (i1 < 0) continue;
    const subject = body.slice(0, i1).trim();
    const rest = body.slice(i1 + 2);
    const i2 = rest.indexOf('::');
    if (kind === 'fact') {
      if (i2 < 0) continue;
      const predicate = rest.slice(0, i2).trim();
      const object = rest.slice(i2 + 2).trim();
      if (!subject || !predicate || !object) continue;
      out.push({
        kind,
        subject: unescapeField(subject),
        predicate: unescapeField(predicate),
        object: unescapeField(object),
        attrs,
      });
    } else {
      const predicate = (i2 < 0 ? rest : rest.slice(0, i2)).trim();
      if (!subject || !predicate) continue;
      out.push({ kind, subject: unescapeField(subject), predicate: unescapeField(predicate), attrs });
    }
  }
  return out;
}

/** Render a FactLine back to markdown (round-trip format). */
export function renderFactLine(f: FactLine): string {
  const attrs = Object.entries(f.attrs)
    .map(([k, v]) => `${k}=${escapeField(String(v))}`)
    .join(', ');
  const s = escapeField(f.subject);
  const p = escapeField(f.predicate);
  const body =
    f.kind === 'fact' ? `${s} :: ${p} :: ${escapeField(f.object ?? '')}` : `${s} :: ${p}`;
  return `- [${f.kind}] ${body}${attrs ? ` {${attrs}}` : ''}`;
}

const VALID_SOURCE_TYPES = new Set(['stated', 'extracted', 'inferred']);

/**
 * Deterministic supersession: within each (subject, predicate) slot, order
 * facts by (valid_from ?? recorded_at); each fact with a successor whose
 * object differs is closed at the successor's valid_from and linked 'updates'.
 * Same-object successors are duplicates/extensions — linked 'extends'.
 */
export function recomputeSupersessions(store: Store): void {
  const db = store.db;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM fact_links WHERE type IN ('updates','extends')`).run();
    // Reset what this function owns — the computed close — and nothing else.
    // A user's close (`invalidate`, or an explicit --valid-until) lives in
    // user_valid_until and is restored below, so the chain can be rebuilt from
    // scratch without discarding intent.
    db.prepare(
      `UPDATE facts SET superseded_at=NULL, superseded_by=NULL,
                        valid_until=user_valid_until`,
    ).run();
    const slots = db
      .prepare(`SELECT DISTINCT subject, predicate FROM facts`)
      .all() as { subject: string; predicate: string }[];
    const linkStmt = db.prepare(
      `INSERT OR IGNORE INTO fact_links(src_fact, dst_fact, type) VALUES (?,?,?)`,
    );
    // A user's close is an upper BOUND, not an override: "it was not true
    // after D". A later fact with a different value is the same kind of claim
    // — "it was not true after D2" — so the binding one is whichever comes
    // first, and MIN satisfies both. Letting the user's close simply win
    // instead left a closed fact overlapping its own successor whenever
    // someone invalidated at one date and then asserted a different value
    // starting earlier.
    //
    // Never COALESCE against the existing valid_until, which is what made a
    // stale computed close permanent.
    const closeStmt = db.prepare(
      `UPDATE facts SET valid_until=MIN(COALESCE(user_valid_until, ?), ?),
                        superseded_at=?, superseded_by=?
       WHERE id=?`,
    );
    for (const slot of slots) {
      const rows = db
        .prepare(
          `SELECT id, object, valid_from, valid_until, recorded_at FROM facts
           WHERE subject=? AND predicate=?
           ORDER BY COALESCE(valid_from, recorded_at) ASC, recorded_at ASC, id ASC`,
        )
        .all(slot.subject, slot.predicate) as {
        id: number;
        object: string;
        valid_from: string | null;
        valid_until: string | null;
        recorded_at: string;
      }[];
      // Every record is closed by the one after it; only the LINK TYPE says
      // whether the value changed. Re-asserting the same value used to `continue`
      // without closing, which broke the chain rather than extending it: with
      // draft(Jan), draft(Mar), final(Aug), Aug closed Mar and nothing ever
      // closed Jan, because Aug was not its immediate neighbour. The slot was
      // then permanently left with two current answers — `lore facts` returned
      // "final (2026-08-01 → now)" and "draft (2026-01-01 → now)" together —
      // and re-confirming a value is an ordinary thing to do.
      //
      // Closing on a re-assertion loses nothing: the value is continuous across
      // the two records, so a point-in-time query lands on whichever record
      // covers the date, and the slot keeps exactly one open row.
      for (let i = 0; i < rows.length - 1; i++) {
        const cur = rows[i]!;
        const next = rows[i + 1]!;
        const sameValue = normalizeKey(next.object) === normalizeKey(cur.object);
        const closeAt = next.valid_from ?? next.recorded_at;
        closeStmt.run(closeAt, closeAt, next.recorded_at, next.id, cur.id);
        linkStmt.run(next.id, cur.id, sameValue ? 'extends' : 'updates');
      }
    }
  });
  tx();
}

/**
 * Wipe and replay all fact rows from fact lines found in vault blocks.
 * Journal notes replay first (chronological by path), then other notes by path.
 */
export function rebuildFactsFromNotes(store: Store, mode: ExtractionMode = 'explicit'): number {
  const db = store.db;
  let count = 0;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM facts`).run();
    const rows = db
      .prepare(
        `SELECT b.note_path AS notePath, b.anchor, b.ord, b.text, n.mtime_ms
         FROM blocks b JOIN notes n ON n.path = b.note_path
         WHERE b.text LIKE '%[fact]%' OR b.text LIKE '%[invalidate]%'
         ORDER BY (CASE WHEN b.note_path LIKE '${JOURNAL_DIR}/%' THEN 0 ELSE 1 END),
                  b.note_path ASC, b.ord ASC`,
      )
      .all() as { notePath: string; anchor: string; ord: number; text: string; mtime_ms: number }[];
    const ins = db.prepare(
      // user_valid_until comes straight back from the journal line's own
      // `valid_until` attr. Without it a rebuild from markdown produced
      // different facts than the live path — the column lived only in the
      // database, which is precisely what the vault-is-the-truth claim forbids.
      `INSERT INTO facts(subject, predicate, object, subject_display, valid_from, valid_until,
                         recorded_at, source_type, note_path, block_anchor, confidence,
                         user_valid_until)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const seen = new Set<string>();
    for (const r of rows) {
      const journal = isJournalPath(r.notePath);
      // journal file name lore/journal/YYYY-MM-DD.md gives a default record date
      const dateFromPath = r.notePath.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
      for (const f of parseFactLines(r.text)) {
        if (f.kind === 'invalidate') {
          // The note's own mtime, never the clock: this replay reruns on
          // EVERY index that touches any note, so a wall-clock fallback
          // re-dated undated records on every unrelated edit — the close
          // drifted, `as-of` answers moved, and `resume` re-reported facts
          // nobody asserted. mtime is a function of the vault; the clock is
          // a function of when you happened to index.
          const until = f.attrs.valid_until ?? dateFromPath ?? new Date(r.mtime_ms).toISOString();
          // Bring the slot up to date before asking what is open.
          //
          // The live path recomputes supersessions after every assert, so by
          // the time an invalidate runs, facts already superseded are closed
          // and it correctly finds nothing to close. Replay batches its
          // inserts, so without this it saw rows that were still open only
          // because the recompute had not happened yet, and closed the wrong
          // one — giving a rebuilt vault different bookkeeping than the live
          // one for the same journal.
          recomputeSupersessions(store);
          // Close only the current winner of the slot; older open facts get
          // closed by the supersession recompute at their successor's date.
          // (Closing all open facts here would diverge from the live path,
          // where supersession has already closed the older ones.)
          if (!normalizeKey(f.subject) || !normalizeKey(f.predicate)) continue;
          db.prepare(
            `UPDATE facts SET valid_until=?, user_valid_until=? WHERE id IN (
               SELECT id FROM facts WHERE subject=? AND predicate=? AND valid_until IS NULL
               ORDER BY COALESCE(valid_from, recorded_at) DESC, recorded_at DESC, id DESC LIMIT 1
             )`,
          ).run(until, until, normalizeKey(f.subject), normalizeKey(f.predicate));
          continue;
        }
        const subject = normalizeKey(f.subject);
        const predicate = normalizeKey(f.predicate);
        // A subject or predicate made only of emoji or punctuation normalises
        // to '', and every such line would land in one shared slot. assertFact
        // refuses them at the API, but the journal is the source of truth and
        // is replayed on every full re-index, so a line written by an older
        // version — or by an agent writing [fact] into a note — would keep
        // recreating those rows, which invalidate can no longer close.
        // extractStructuredFacts below has always had this guard.
        if (!subject || !predicate) continue;
        const recordedAt =
          f.attrs.recorded_at ??
          (dateFromPath ? `${dateFromPath}T00:00:00.000Z` : new Date(r.mtime_ms).toISOString());
        // Identity of a FACT: same slot, same value, same validity window.
        // `recorded_at` is deliberately not part of it — logging the identical
        // claim twice is one fact stated twice, not two facts. `valid_until`
        // is, because "final from June until January" and "final from June" are
        // a bounded claim and an open-ended one, and collapsing them made a
        // rebuild produce facts the live path never had.
        //
        // assertFact applies the same key, so the two paths agree.
        const dedupe = [
          subject,
          predicate,
          normalizeKey(f.object ?? ''),
          f.attrs.valid_from ?? '',
          f.attrs.valid_until ?? '',
        ].join('|');
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const rawSource = f.attrs.source ?? (journal ? 'stated' : 'extracted');
        const sourceType = VALID_SOURCE_TYPES.has(rawSource) ? rawSource : 'extracted';
        const conf = Number(f.attrs.confidence);
        ins.run(
          subject,
          predicate,
          f.object ?? '',
          f.subject,
          f.attrs.valid_from ?? null,
          f.attrs.valid_until ?? null,
          recordedAt,
          sourceType,
          r.notePath,
          r.anchor,
          Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.9,
          f.attrs.valid_until ?? null,
        );
        count++;
      }
    }
  });
  tx();
  count += extractStructuredFacts(store, mode);
  recomputeSupersessions(store);
  return count;
}

/**
 * Second pass: mine facts from ordinary note structure (frontmatter, inline
 * fields, bold-label lists). These are `extracted`, never `stated`, and never
 * overwrite an explicit assertion for the same slot — an explicit
 * `- [fact]` line always wins.
 */
export function extractStructuredFacts(
  store: Store,
  mode: ExtractionMode = 'explicit',
): number {
  if (mode === 'off') return 0;
  const db = store.db;
  let count = 0;
  const notes = db
    .prepare(`SELECT path, title, frontmatter, mtime_ms FROM notes ORDER BY path`)
    .all() as { path: string; title: string; frontmatter: string; mtime_ms: number }[];
  const blocksFor = db.prepare(
    `SELECT anchor, heading, ord, text, hash FROM blocks WHERE note_path=? ORDER BY ord`,
  );
  const stated = new Set(
    (
      db
        .prepare(`SELECT DISTINCT subject, predicate FROM facts WHERE source_type='stated'`)
        .all() as { subject: string; predicate: string }[]
    ).map((r) => `${r.subject}|${r.predicate}`),
  );
  // valid_until is bound, not hardcoded NULL. user_valid_until takes the same
  // value for the same reason the journal path gives it one: an explicit close
  // is the author's intent, and recomputeSupersessions narrows valid_until with
  // MIN(COALESCE(user_valid_until, …)) — so a row that kept its close only in
  // valid_until would lose it the first time a successor fact arrived.
  const ins = db.prepare(
    `INSERT INTO facts(subject, predicate, object, subject_display, valid_from, valid_until,
                       recorded_at, source_type, note_path, block_anchor, confidence,
                       user_valid_until)
     VALUES (?,?,?,?,?,?,?,'extracted',?,?,?,?)`,
  );
  const tx = db.transaction(() => {
    for (const n of notes) {
      if (isJournalPath(n.path)) continue; // already replayed verbatim
      let fm: Record<string, unknown> = {};
      try {
        fm = JSON.parse(n.frontmatter) as Record<string, unknown>;
      } catch {
        /* malformed frontmatter is already reported by the parser */
      }
      const note: Note = {
        path: n.path,
        title: n.title,
        frontmatter: fm,
        tags: [],
        links: [],
        blocks: blocksFor.all(n.path) as Note['blocks'],
        hash: '',
        mtimeMs: n.mtime_ms,
        size: 0,
        warnings: [],
      };
      const recordedAt = new Date(n.mtime_ms).toISOString();
      for (const f of extractFactsFromNote(note, mode)) {
        const subject = normalizeKey(f.subject);
        const predicate = normalizeKey(f.predicate);
        if (!subject || !predicate) continue;
        if (stated.has(`${subject}|${predicate}`)) continue; // explicit wins
        ins.run(
          subject,
          predicate,
          f.object,
          f.subject,
          f.validFrom ?? null,
          f.validUntil ?? null,
          recordedAt,
          n.path,
          f.blockAnchor || null,
          f.confidence,
          f.validUntil ?? null,
        );
        count++;
      }
    }
  });
  tx();
  return count;
}
