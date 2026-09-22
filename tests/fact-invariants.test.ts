import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.js';
import { indexVault } from '../src/index/indexer.js';
import { assertFact, invalidateFact, queryFacts } from '../src/facts/model.js';
import { rebuildFactsFromNotes } from '../src/facts/journal.js';
import { ConfigSchema } from '../src/config.js';
import { buildGraph, type LoreGraph } from '../src/graph/build.js';
import { buildNoteLinkGraph } from '../src/retrieve/expand.js';
import type { LoreContext } from '../src/context.js';
import { makeVault } from './helpers.js';

/**
 * The fact store's invariants, checked against generated histories rather than
 * hand-picked ones.
 *
 * Three examples written by hand all passed while 127 of 300 random histories
 * did not. The failures were ordinary: asserting facts out of valid-time order,
 * or invalidating and then asserting again. Both left a slot with two values
 * valid at the same instant, silently, forever.
 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const VALUES = ['draft', 'final', 'archived'];
const DATES = [
  '2024-01-01', '2024-06-01', '2025-01-01', '2025-06-01', '2026-01-01', '2026-06-01',
];

async function emptyCtx(): Promise<LoreContext> {
  const root = await makeVault({ 'a.md': '# A\n\nseed\n' });
  const config = ConfigSchema.parse({});
  const store = openStore(':memory:');
  await indexVault(store, root);
  let cached: LoreGraph | null = null;
  return {
    root, config, store, provider: null,
    graph: () => (cached ??= buildGraph(store, config)),
    noteLinks: () => buildNoteLinkGraph(store),
    invalidateGraph: () => { cached = null; },
    close: () => store.close(),
  };
}

describe('fact store invariants', () => {
  it('hold across 200 generated histories', async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const ctx = await emptyCtx();
      const history: string[] = [];
      const ops = 2 + Math.floor(rand() * 6);
      for (let i = 0; i < ops; i++) {
        const date = DATES[Math.floor(rand() * DATES.length)]!;
        try {
          if (rand() < 0.15) {
            invalidateFact(ctx, { subject: 'S', predicate: 'p', validUntil: date });
            history.push(`invalidate@${date}`);
          } else {
            const v = VALUES[Math.floor(rand() * VALUES.length)]!;
            assertFact(ctx, { subject: 'S', predicate: 'p', object: v, validFrom: date });
            history.push(`${v}@${date}`);
          }
        } catch {
          // incoherent input (closing a fact before it began) is refused on
          // purpose; the point is that what IS accepted stays consistent
        }
      }
      const where = `seed ${seed}: ${history.join(' -> ')}`;

      // one current value per slot
      expect(queryFacts(ctx.store, { subject: 'S', predicate: 'p' }).length, where)
        .toBeLessThanOrEqual(1);

      // one value valid at any instant
      for (const d of DATES) {
        expect(queryFacts(ctx.store, { subject: 'S', predicate: 'p', asOf: d }).length, `${where} @${d}`)
          .toBeLessThanOrEqual(1);
      }

      // the chain is linear
      const forked = ctx.store.db
        .prepare(
          `SELECT COUNT(*) c FROM (SELECT superseded_by FROM facts
             WHERE superseded_by IS NOT NULL GROUP BY superseded_by HAVING COUNT(*) > 1)`,
        )
        .get() as { c: number };
      expect(forked.c, where).toBe(0);

      // nothing is closed before it began
      const inverted = ctx.store.db
        .prepare(
          `SELECT COUNT(*) c FROM facts WHERE valid_until IS NOT NULL AND valid_until < valid_from`,
        )
        .get() as { c: number };
      expect(inverted.c, where).toBe(0);

      ctx.close();
    }
  }, 120_000);

  it("a user's close bounds the interval but cannot extend it", async () => {
    // Closing at a date says "not true after D". A later fact with a different
    // value says the same thing about an earlier date. Both are constraints, so
    // the binding one is whichever comes first — letting the user's close win
    // outright left a closed fact overlapping its own successor.
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'draft', validFrom: '2024-01-01' });
    invalidateFact(ctx, { subject: 'S', predicate: 'p', validUntil: '2025-01-01' });
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'final', validFrom: '2024-06-01' });

    const at = queryFacts(ctx.store, { subject: 'S', asOf: '2024-09-01' });
    expect(at).toHaveLength(1);
    expect(at[0]!.object).toBe('final');
    ctx.close();
  });

  it('refuses to close a fact before it began', async () => {
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'x', validFrom: '2025-06-01' });
    expect(() =>
      invalidateFact(ctx, { subject: 'S', predicate: 'p', validUntil: '2025-01-01' }),
    ).toThrow(/before the fact became valid/);
    ctx.close();
  });

  it('a user close still survives when nothing supersedes it', async () => {
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'x', validFrom: '2024-01-01' });
    invalidateFact(ctx, { subject: 'S', predicate: 'p', validUntil: '2025-01-01' });
    expect(queryFacts(ctx.store, { subject: 'S' })).toHaveLength(0);
    expect(queryFacts(ctx.store, { subject: 'S', asOf: '2024-06-01' })).toHaveLength(1);
    ctx.close();
  });
});

describe('markdown is the source of truth', () => {
  // The claim the whole design rests on: the journal is the record, and
  // deleting the index and replaying it must reproduce the same facts. One
  // hand-written example passed while 68 of 120 generated histories did not.
  const state = (store: ReturnType<typeof openStore>) =>
    JSON.stringify(
      store.db
        .prepare(
          `SELECT subject,predicate,object,valid_from,valid_until,user_valid_until,
                  note_path,block_anchor,
                  superseded_by IS NOT NULL AS superseded
           FROM facts ORDER BY subject,predicate,valid_from,object,valid_until`,
        )
        .all(),
    );

  it('a rebuild from the journal reproduces the live fact store, over 120 histories', async () => {
    const VALUES = ['draft', 'final', 'archived'];
    const DATES = ['2024-01-01', '2024-06-01', '2025-01-01', '2025-06-01', '2026-01-01'];
    const SUBJECTS = ['Atlas', 'Ledger'];

    for (let seed = 1; seed <= 120; seed++) {
      const rand = rng(seed);
      const ctx = await emptyCtx();
      const history: string[] = [];
      for (let i = 0; i < 2 + Math.floor(rand() * 6); i++) {
        const subject = SUBJECTS[Math.floor(rand() * SUBJECTS.length)]!;
        const date = DATES[Math.floor(rand() * DATES.length)]!;
        try {
          if (rand() < 0.2) {
            invalidateFact(ctx, { subject, predicate: 'status', validUntil: date });
            history.push(`invalidate ${subject} until=${date}`);
          } else if (rand() < 0.15) {
            const v = VALUES[Math.floor(rand() * 3)]!;
            const u = DATES[Math.floor(rand() * DATES.length)]!;
            assertFact(ctx, { subject, predicate: 'status', object: v, validFrom: date, validUntil: u });
            history.push(`assert ${subject} ${v} ${date}..${u}`);
          } else {
            const v = VALUES[Math.floor(rand() * 3)]!;
            assertFact(ctx, { subject, predicate: 'status', object: v, validFrom: date });
            history.push(`assert ${subject} ${v} ${date}`);
          }
        } catch {
          // incoherent input refused on purpose
        }
      }
      const live = state(ctx.store);
      await indexVault(ctx.store, ctx.root);
      rebuildFactsFromNotes(ctx.store);
      expect(state(ctx.store), `seed ${seed}: ${history.join(' | ')}`).toBe(live);
      ctx.close();
    }
  }, 180_000);

  it('an identical assertion is one fact, however many times it is logged', async () => {
    // Two byte-identical journal lines are the same claim stated twice. The
    // live path inserted a second row and then closed the first at its own
    // start — a zero-length fact — while a replay collapsed them.
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'x', validFrom: '2025-01-01' });
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'x', validFrom: '2025-01-01' });
    const all = ctx.store.db.prepare(`SELECT COUNT(*) c FROM facts`).get() as { c: number };
    expect(all.c).toBe(1);
    ctx.close();
  });

  it('a bounded claim and an open-ended one are different facts', async () => {
    // "x from June until January" and "x from June" say different things; the
    // replay's dedupe key ignored valid_until and collapsed them.
    const ctx = await emptyCtx();
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'x', validFrom: '2025-01-01', validUntil: '2025-06-01' });
    assertFact(ctx, { subject: 'S', predicate: 'p', object: 'x', validFrom: '2025-01-01' });
    const all = ctx.store.db.prepare(`SELECT COUNT(*) c FROM facts`).get() as { c: number };
    expect(all.c).toBe(2);
    ctx.close();
  });

  it('refuses an assertion that ends before it begins', async () => {
    const ctx = await emptyCtx();
    expect(() =>
      assertFact(ctx, {
        subject: 'S', predicate: 'p', object: 'x',
        validFrom: '2025-06-01', validUntil: '2024-01-01',
      }),
    ).toThrow(/before validFrom/);
    ctx.close();
  });
});
