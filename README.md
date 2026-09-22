<h1 align="center">Loreweave</h1>

<p align="center">
  <strong>A temporal knowledge engine for markdown vaults.</strong><br>
  It indexes, links, remembers, forgets, and dreams — locally, over files you own.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/loreweave"><img src="https://img.shields.io/npm/v/loreweave" alt="npm"></a>
  <a href="https://github.com/lets-order-some-fries/loreweave/actions/workflows/ci.yml"><img src="https://github.com/lets-order-some-fries/loreweave/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen" alt="node >= 20">
  <img src="https://img.shields.io/npm/l/loreweave" alt="MIT">
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#the-cli">CLI</a> ·
  <a href="#use-it-as-agent-memory-mcp">Agent memory</a> ·
  <a href="#benchmarks">Benchmarks</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#research-lineage">Research</a>
</p>

---

<p align="center">
  <img src="docs/demo.gif" alt="loreweave demo: temporal search, timeline, as-of facts, session resume" width="720">
</p>

Most knowledge tools are **write-only**. You capture diligently, the vault grows, and
six months later you can't find the thing you know you wrote — because retrieval is
keyword search over prose, nothing ever resurfaces on its own, and nothing notices when
what you wrote last year stopped being true.

Loreweave is the layer that fixes that. Point it at a folder of markdown (Obsidian or
plain) and it builds a knowledge graph, a bitemporal fact store, and a memory model over
your notes — then hands them to you through a CLI and to your AI agents through MCP.

Three guarantees, enforced by the code rather than promised:

- **Your files win.** User markdown is never mutated; the engine only appends, and only
  under `lore/`. The vault is the source of truth — **the index is a cache you can
  delete at any time** and rebuild identically (there's a test for that).
- **No LLM anywhere in the core.** Indexing and retrieval use zero tokens and make zero
  network calls. Same vault, same query, same answer — forever.
- **Memory you can read.** Every fact an agent stores is a markdown line you can open,
  edit, and `git diff`.

## Quickstart

```bash
cd ~/my-vault
npx loreweave init          # creates .lore/
npx loreweave index         # incremental sync; one changed note: 32 ms at 1k notes, 656 ms at 20k (see Scale)

npx loreweave search "why did we drop the queue design"
npx loreweave ask "what's the status of project atlas"
npx loreweave dream         # what's duplicated, contradicted, stale, unlinked
```

Zero configuration and no network: out of the box it runs on BM25 + knowledge-graph
spreading activation. Add local embeddings when you want them:

```jsonc
// .lore/config.json
{ "embedding": { "provider": "ollama", "model": "mxbai-embed-large" } }
```

Pick `mxbai-embed-large` (670 MB) for quality or `nomic-embed-text` (274 MB) when disk
and indexing speed matter more — required task prefixes are applied automatically for
both, and for the E5, BGE and Arctic families. The measured difference between the two
is in [Benchmarks](#benchmarks). No embedding provider means lexical + graph retrieval,
still fully functional.

Works with non-English vaults: Chinese, Japanese and Korean text is segmented per
character so it is searchable at all, and other scripts index as written.

## What it does

**1. Knowledge that has a timeline.** Facts are bitemporal: when they were true in the
world (`valid_from`/`valid_until`) and when the system learned them (`recorded_at`).
Contradictions **supersede** rather than overwrite, so history stays queryable.

```bash
$ lore assert "Ledger Format" status draft --valid-from 2026-01-01
$ lore assert "Ledger Format" status final --valid-from 2026-08-01
✓ Ledger Format :: status :: final
  superseded: "draft" (now valid until 2026-08-01)
  journal: lore/journal/2026-08-01.md
```

(`lore` and `loreweave` are the same binary — `npm i -g loreweave` gives you both;
`npx loreweave` works without installing.)

Both time axes are queryable, which is what makes it bitemporal rather than merely
historical. `--as-of` asks what was *true* then; `--as-known-at` asks what was
*believed* then. They disagree exactly when you learn something after the fact — which
is when you most need to reconstruct what a past decision was actually based on:

```bash
$ lore facts --subject Vendor --as-of 2024-06-01
Vendor :: reliability :: poor — outage postmortem  (2024-01-01 → now)

$ lore facts --subject Vendor --as-known-at 2024-06-01
Vendor :: reliability :: good  (2024-01-01 → 2024-01-01)  [superseded]
```

Which fact wins is decided **deterministically** (newest valid-time, provenance as
tiebreak) — never by asking a language model which one looks fresher. And the whole
history of anything is one command — every value change merged chronologically with the
dated prose that mentions it:

```bash
$ lore timeline Project Atlas
2024-01-15  status: planning  (until 2024-09-01)
2024-02-10  • [[Project Atlas]] kicked off with a three-person crew.  [kickoff.md]
2024-09-01  status: planning → active
2025-06-20  • The [[Project Atlas]] midpoint review went long but well.  [review.md]
```

Temporal-graph systems build this by running an LLM over every document at ingestion.
Here the supersede chain has been maintained all along, so it is a read-side join: no
LLM, no network, same answer every time.

**2. Retrieval that follows connections, not just words.** Queries fuse BM25, dense
similarity (when configured), and Personalized PageRank over the vault's own graph —
wiki-links, shared entities, tags, co-occurrence. Two-hop neighbors surface even when
they share no vocabulary with your query, and every result tells you *why*:

```
• data/glacier-dataset.md#@0  (0.0327)  ⟨via amara osei⟩
  The Glacier Dataset holds meltwater sensor readings from 2019-2024.
```

**3. Memory with dynamics.** Every passage carries FSRS-style stability and
retrievability — a power-law forgetting curve. Passages that actually get *used* (not
merely retrieved) decay slower; important-but-fading knowledge gets surfaced for review
instead of silently rotting. Nothing is ever deleted.

**4. It dreams.** `lore dream` is an idle-time consolidation pass that reviews the vault
and reports duplicate passages, contradicted facts, stale knowledge, missing links
between notes that clearly belong together, and orphans. With `--apply` it writes a
digest and a review queue — **append-only, under `lore/`**. It never rewrites your prose:
LLM-driven whole-file rewriting is a documented failure mode — each rewrite quietly
drops details until the file collapses to mush — so the architecture forbids it.

**5. Questions retrieval can't answer.** Counting, grouping, and date-range queries run
as deterministic SQL over the fact store, not as vibes over embeddings:

```bash
$ lore count --predicate trip_to --since 2025-01-01 --until 2025-12-31
    2  Japan
    1  Kenya
```

**6. Facts come from your notes, not from a form.** Nobody hand-writes
`- [fact] X :: y :: z`, so the extractor mines the conventions vaults already use:

```yaml
status: shipped              # frontmatter
- owner:: Priya              # Dataview inline field
- [location] Hyderabad       # Basic Memory observation
```

Only unambiguous field syntax is accepted automatically. Prose formatting like
`- **Owner:** Priya` is precise on entity notes and noisy on report notes, so it is
opt-in (`facts.extract: "all"`) — or an agent can review candidates via
`lore_propose_facts` and assert the real ones. Judgement stays out of the index.

**7. Time means when it happened, not when you saved the file.** `--since` and
`--until` filter on *content* time — frontmatter dates, dated filenames
(`2025-03-14-standup.md`), or dates in the text — falling back to file mtime only when
a note carries no date of its own. `lore watch` keeps the index current so you never
have to remember to reindex.

**8. Built for agents.** An MCP server exposes 15 typed tools so Claude Code, Cursor,
or any MCP client can use your vault as durable memory. Session continuity is a query,
not a paraphrase — `lore resume` returns exactly what changed since the agent last
connected, computed from record time:

```bash
$ lore resume
since 2026-08-11 15:55
~ lore/journal/2026-08-11.md
+ Project Atlas :: status :: shipped (since 2026-08-11)
± Project Atlas :: status: active → shipped

$ lore resume
since 2026-08-11 15:56
nothing changed
```

Alternatives that summarize the previous session with an LLM inject a paraphrase; this
is a deterministic diff. Full setup in [Agent memory](#use-it-as-agent-memory-mcp).

## The CLI

| Command | What it does |
|---|---|
| `lore init` | create `.lore/` with a default config |
| `lore index [--full] [--no-nlp] [--rebuild-similar]` | incremental sync of vault → index |
| `lore search <q> [-k] [--since] [--until] [--tag] [--folder] [--json]` | hybrid retrieval with provenance |
| `lore ask <q>` | extractive answer: current facts + top passages (no LLM needed) |
| `lore facts [--subject] [--predicate] [--as-of] [--as-known-at] [--history] [--limit]` | query the fact store (200 rows unless `--limit` says otherwise; a capped list says how many it left out) |
| `lore timeline <entity> [--since] [--until]` | chronological history: fact changes merged with dated mentions |
| `lore resume [--since]` | what changed since the last resume: notes, facts, supersessions |
| `lore review [--threshold] [--limit]` | important-but-fading knowledge to revisit or archive |
| `lore assert <s> <p> <o…> [--valid-from]` | record a fact (journalled, supersedes) |
| `lore invalidate <s> <p>` | close the current fact in a slot |
| `lore count [--predicate] [--group-by] [--since]` | aggregate over fact history |
| `lore capture <text…>` | append a timestamped line to `lore/inbox.md` |
| `lore dream [--apply]` | consolidation pass + optional digest/review queue |
| `lore watch` | reindex automatically as the vault changes |
| `lore mark-used <note> [anchor]` | reinforce a passage that proved useful |
| `lore graph export --format json\|graphml\|dot` | export the graph |
| `lore doctor` | health check: broken links, integrity, coverage |
| `lore stats` | vault statistics and top entities |
| `lore serve --mcp` | start the MCP server on stdio |

## Use it as agent memory (MCP)

```jsonc
// Claude Code: .mcp.json  (or claude_desktop_config.json)
{
  "mcpServers": {
    "loreweave": {
      "command": "npx",
      "args": ["-y", "loreweave", "--vault", "/path/to/vault", "serve", "--mcp"]
    }
  }
}
```

| Tool | What the agent gets |
|---|---|
| `lore_search` | hybrid retrieval with provenance and temporal filters |
| `lore_context_pack` | one-call session context: relevant passages + current facts + recent changes |
| `lore_read_note` | full text of a note by path |
| `lore_assert_fact` / `lore_invalidate_fact` | write/close facts — journalled, superseding, never destructive |
| `lore_query_facts` | point-in-time fact queries (`asOf`, `asKnownAt`, history) |
| `lore_timeline` | an entity's merged fact + prose chronology |
| `lore_resume` | exactly what changed since the agent last connected |
| `lore_review` | important-but-fading passages worth resurfacing |
| `lore_aggregate_facts` | count/group-by over fact history |
| `lore_capture` | append a timestamped line to the inbox |
| `lore_mark_used` | reinforcement signal: this passage actually helped |
| `lore_propose_facts` | extraction candidates for the agent to review and assert |
| `lore_dream_report` | the consolidation report (duplicates, contradictions, stale, orphans) |
| `lore_index` | trigger a reindex |

Facts asserted through MCP are written back to `lore/journal/YYYY-MM-DD.md` as readable
markdown, so an agent's memory is something you can open, edit, and `git diff`:

```markdown
- [fact] Ledger Format :: status :: final {valid_from=2026-08-01, confidence=0.9, source=stated}
```

Delete `.lore/` and reindex — every fact and edge is reconstructed from those files.

**Compared to hosted memory services** (Mem0, Zep): those run LLMs at write time to
extract and summarize into their own store; loreweave runs no model in the core, keeps
memory in your files under your version control, and makes every retrieval
reproducible. The trade: they do abstractive summarization, this engine deliberately
does not. Retrieval quality against their published benchmarks is below — with the
caveats stated, because most published agent-memory numbers measure end-to-end QA with
an LLM, which is a different quantity than retrieval.

## Benchmarks

These are third-party benchmarks with relevance labels nobody here chose. All loreweave
numbers are **retrieval** metrics — it finds the evidence, it does not write the
answer — so they are not comparable to the end-to-end QA accuracy quoted by systems
that put a language model after retrieval. Reproduce any number:
[`docs/benchmarks.md`](docs/benchmarks.md). Field comparison with the traps called out:
[`docs/scoreboard.md`](docs/scoreboard.md).

**LongMemEval_S** (ICLR 2025) — 500 questions, each with ~50 sessions of chat history;
find the sessions holding the evidence. Session-level recall, all 500 questions:

| configuration | R@1 | R@5 | R@10 |
|---|---|---|---|
| model-free (no embeddings, no network) | 0.552 | 0.899 | 0.943 |
| + embeddings & 8-turn chunking | **0.590** | **0.959** | **0.983** |

[A third-party benchmark][lme] of the same task reports BM25 alone at **86.2%** R@5,
BM25+vector hybrid at **95.2%**, and a vector-only system at **96.6%**. One caveat
before the comparison: their metric scores a question 1 if *any* gold session is
retrieved, ours scores the *fraction* of gold sessions found — ours is the stricter
definition, so treat cross-system gaps of under a point as noise. With that stated:
**at 95.9% loreweave is past the hybrid and just short of the vector-only system**,
with a local model, no network, and a lexical index it can fall back to.

[lme]: https://github.com/rohitg00/agentmemory/blob/main/benchmark/LONGMEMEVAL.md

**BEIR / SciFact** — 5 183 scientific abstracts, 300 claims, scored by nDCG@10
(ranking quality: rewards putting relevant documents nearer the top):

| configuration | nDCG@10 | Recall@10 |
|---|---|---|
| BM25 baseline (BEIR paper, Anserini) | 0.665 | — |
| loreweave, model-free | 0.681 | 0.817 |
| loreweave + nomic-embed-text | 0.727 | 0.865 |
| loreweave + mxbai-embed-large | **0.742** | **0.884** |

**LoCoMo** — 10 long conversations, 1 982 evidence-labelled questions, turn-level
recall. No comparable third-party *retrieval* number exists (published LoCoMo results
are LLM QA accuracy), so these are offered as a target rather than a comparison:

| | R@1 | R@5 | R@10 | R@20 |
|---|---|---|---|---|
| model-free | 0.337 | 0.538 | 0.610 | 0.656 |
| + embeddings | 0.318 | 0.532 | **0.627** | **0.705** |

**What the numbers say, plainly.** Recall is strong and rank-1 is the weakness —
LongMemEval R@10 0.983 vs R@1 0.590 — which is why figures here are quoted at R@5 and
why an agent consuming these results should read a top-5 list, not trust rank 1. The
single biggest quality lever measured is the embedding model itself: mxbai over nomic
is worth more than every downstream tuning combined on document (BEIR) and session
(LongMemEval) retrieval — and measures flat on LoCoMo's single-turn passages, so it
is a scale effect, not magic. A cross-encoder reranker is available (`rerank` in config) but earns its keep only
for rank-1 consumers without embeddings — stacked on embeddings it *loses* recall on
both public benchmarks, so leave it off unless that trade is yours. Full analysis,
including the failed experiments and the defect that benchmarking caught:
[`docs/evaluation.md`](docs/evaluation.md).

Loreweave also ships an internal regression benchmark (`npm run eval`) over three
purpose-built vaults — including a temporal-perturbation test where the shipped config
scores **100% consistency vs BM25's 0%**, gated in CI on every push. Internal corpora
are good for regression and worthless as proof, so the details live in
[`docs/evaluation.md`](docs/evaluation.md) rather than here.

## Scale

Measured, like the quality numbers — `npm run scale` reproduces this on your own
machine (synthetic vaults, 3 blocks per note, dense interlinking):

| notes | blocks | entities | edges | full index | incremental | search p50 | p95 | dream | heap |
|---|---|---|---|---|---|---|---|---|---|
| 1 000 | 3 000 | 2 766 | 17 k | 1.2 s | 32 ms | 3 ms | 4 ms | 0.2 s | 63 MB |
| 5 000 | 15 000 | 13 766 | 85 k | 6.1 s | 165 ms | 9 ms | 12 ms | 1.0 s | 145 MB |
| 20 000 | 60 000 | 55 016 | 339 k | 22.5 s | 656 ms | 38 ms | 53 ms | 4.8 s | 333 MB |

Full index scales at **0.93× per note** from 5 k to 20 k — linear or better, no
superlinear step hiding in the middle. "Incremental" is one changed note, which is what
`lore watch` actually does all day. Everything here is one process, one SQLite file, no
daemon — and search at 3-38 ms p50 is fast enough to sit inside an agent loop.

## How it works

```
vault/*.md ──parse──▶ notes · blocks · wiki-links · tags · entities
                            │  (incremental: mtime + content hash)
                            ▼
                  SQLite .lore/index.db  ── disposable cache, rebuildable
                            │
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                    ▼
   graph (CSR)         retrieval             facts
   blocks ∪ entities   BM25 + dense + PPR    bitemporal, supersession,
   2-iteration PPR     → weighted RRF        deterministic freshness,
   α = 0.5             → FSRS boosts         aggregates
        └─────────┬─────────┴──────────┬─────────┘
                  ▼                    ▼
             dream (idle-time)     CLI · MCP
```

Design rules the code enforces:

- **Files win.** User markdown is never mutated. The engine only appends, and only under
  `lore/`.
- **Invariants in code, not prompts.** Schema, migrations, graph construction, and
  supersession are typed, versioned, and tested — no LLM re-specifies them at runtime.
- **No LLM required anywhere in the core.** Indexing and retrieval use zero tokens.
  Language models are consumers of this engine, not dependencies of it.
- **Everything is re-derivable.** A full rebuild reproduces byte-identical derived state
  (there's a test for that).

## Research lineage

Every significant choice traces to 2024-2026 literature; the survey lives in
[`docs/research/`](docs/research/).

| Choice | Source |
|---|---|
| Dense-sparse fusion + PPR with dense reset probabilities | HippoRAG 2 (ICML 2025), [2502.14802](https://arxiv.org/abs/2502.14802) |
| Shallow 2-iteration PPR, heterogeneous nodes | NodeRAG (2025), [2504.11544](https://arxiv.org/abs/2504.11544) |
| Relation-free graph — no LLM triple extraction | LinearRAG (ICLR 2026), [2510.10114](https://arxiv.org/abs/2510.10114) |
| No index-time community summarization | LazyGraphRAG (Microsoft, 2024) — same quality at 0.1% index cost |
| Route/fuse instead of graph-everything | GraphRAG-Bench (ICLR 2026), [2506.05690](https://arxiv.org/abs/2506.05690) |
| Bitemporal facts, invalidate-never-delete | Zep/Graphiti (2025), [2501.13956](https://arxiv.org/abs/2501.13956) |
| Power-law forgetting, use-gated reinforcement | FSRS; RMM (ACL 2025), [2503.08026](https://arxiv.org/abs/2503.08026) |
| Consolidation as idle-time work | Sleep-time compute (Letta, 2025), [2504.13171](https://arxiv.org/abs/2504.13171) |
| Never let an LLM rewrite whole memory files | ACE (2025), [2510.04618](https://arxiv.org/abs/2510.04618) |
| Computable facts for aggregation | User as Code (2026), [2606.16707](https://arxiv.org/abs/2606.16707) |
| Fine-grained indexing + fact-augmented keys | LongMemEval (ICLR 2025), [2410.10813](https://arxiv.org/abs/2410.10813) |

## Library use

```ts
import { openContext, indexVault, search, assertFact, queryFacts, dream } from 'loreweave';

const ctx = openContext('/path/to/vault');
await indexVault(ctx.store, ctx.root);
const hits = await search(ctx, 'streaming compaction', { k: 5 });
assertFact(ctx, { subject: 'Atlas', predicate: 'status', object: 'shipped', validFrom: '2026-08-01' });
const asOfMarch = queryFacts(ctx.store, { subject: 'Atlas', asOf: '2026-03-01' });
const report = dream(ctx);
ctx.close();
```

## Development

```bash
npm install
npm test          # 440 tests
npm run eval      # retrieval benchmark vs BM25 baseline
npm run typecheck
npm run build
```

Requires Node ≥ 20. Single native dependency (`better-sqlite3`). Tested in CI on
Linux, macOS and Windows across Node 20 and 22.

## License

MIT © Ambuj Upadhyay
