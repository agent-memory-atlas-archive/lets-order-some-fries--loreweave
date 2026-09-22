import type { Store } from '../store/db.js';
import { normalizeKey } from '../normalize.js';
import { buildNameIndex, buildNameResolver, resolveNoteName } from '../retrieve/expand.js';
import { daysBetween, reinforce, retrievability } from './fsrs.js';
import { vaultDecay } from './fit.js';

/**
 * Mark blocks as actually USED (cited in an answer, followed by the user).
 * This — not mere retrieval — reinforces stability (RMM's citation signal).
 */
export function markUsed(store: Store, blockIds: number[]): number {
  const now = new Date();
  const nowIso = now.toISOString();
  let updated = 0;
  const tx = store.db.transaction(() => {
    const decay = vaultDecay(store);
    const get = store.db.prepare(`SELECT stability, last_accessed FROM blocks WHERE id=?`);
    const set = store.db.prepare(
      `UPDATE blocks SET stability=?, last_accessed=?, access_count=access_count+1, archived=0 WHERE id=?`,
    );
    for (const id of blockIds) {
      const row = get.get(id) as { stability: number; last_accessed: string | null } | undefined;
      if (!row) continue;
      const days = daysBetween(row.last_accessed, now);
      const R = row.last_accessed ? retrievability(days, row.stability, decay) : 0.9;
      set.run(reinforce(row.stability, R), nowIso, id);
      store.logAccess('used', id);
      updated++;
    }
  });
  tx();
  return updated;
}

/** Resolve blocks by note path (+ optional anchor) → ids, for markUsed. */
export function resolveBlockIds(store: Store, notePath: string, anchor?: string): number[] {
  if (anchor !== undefined) {
    const row = store.db
      .prepare(`SELECT id FROM blocks WHERE note_path=? AND anchor=?`)
      .get(notePath, anchor) as { id: number } | undefined;
    return row ? [row.id] : [];
  }
  const rows = store.db.prepare(`SELECT id FROM blocks WHERE note_path=?`).all(notePath) as {
    id: number;
  }[];
  return rows.map((r) => r.id);
}

/**
 * Recompute heuristic importance for all blocks from link degrees + recency.
 * Runs after indexing; cheap (pure SQL aggregation).
 */
export function updateImportance(store: Store): void {
  const db = store.db;
  const now = Date.now();
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const notes = db.prepare(`SELECT path, title, frontmatter, mtime_ms FROM notes`).all() as {
    path: string;
    title: string;
    frontmatter: string;
    mtime_ms: number;
  }[];
  // Resolve link targets the same way the link graph does — nearest note by
  // path when a name is ambiguous. Two notes sharing a title otherwise sent
  // every inbound link to whichever was enumerated last, so one got credit for
  // the other's backlinks.
  const candidates = buildNameIndex(notes);
  const resolver = buildNameResolver(candidates);
  const links = db.prepare(`SELECT note_path AS src, target_norm FROM links`).all() as {
    src: string;
    target_norm: string;
  }[];
  for (const l of links) {
    outDeg.set(l.src, (outDeg.get(l.src) ?? 0) + 1);
    const dst = resolveNoteName(candidates, l.target_norm, l.src, resolver);
    if (dst) inDeg.set(dst, (inDeg.get(dst) ?? 0) + 1);
  }
  const upd = db.prepare(`UPDATE blocks SET importance=? WHERE note_path=?`);
  const tx = db.transaction(() => {
    for (const n of notes) {
      let prio: number | undefined;
      try {
        const fm = JSON.parse(n.frontmatter) as Record<string, unknown>;
        const p = fm.priority ?? fm.importance;
        if (typeof p === 'number') prio = Math.min(1, Math.max(0, p > 1 ? p / 10 : p));
      } catch {
        /* ignore */
      }
      const recencyDays = (now - n.mtime_ms) / 86_400_000;
      let score = 0.15;
      score += 0.1 * Math.log2(1 + (inDeg.get(n.path) ?? 0));
      score += 0.05 * Math.log2(1 + (outDeg.get(n.path) ?? 0));
      if (prio !== undefined) score += 0.3 * prio;
      if (recencyDays <= 7) score += 0.1;
      else if (recencyDays <= 30) score += 0.05;
      upd.run(Math.min(1, Math.max(0, score)), n.path);
    }
  });
  tx();
}
