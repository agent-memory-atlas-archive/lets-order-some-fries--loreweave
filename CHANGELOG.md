# Changelog

## 0.37.3 — 2026-09-22

- **Search no longer answers from an index that a Ctrl-C left half-built.** An index
  interrupted during its first build stops part-way and leaves a dead PID in
  `meta.index_in_progress`. `lore stats` and `lore doctor` have always reported that
  ("index: INCOMPLETE"), but they were the only two callers that asked: `lore search`,
  `lore ask` and every MCP tool answered from whatever fraction happened to be indexed
  and said nothing. Measured on a 3 000-note vault, a plain Ctrl-C 1.2 s in left 1 947
  notes (65%); `lore search` for a note in the missing third printed "no results" and
  exited 0, and `lore_context_pack` reported `notes: 1947` with no caveat in the payload.
  SIGINT, SIGTERM and SIGHUP all leave the identical state, so the trigger is an ordinary
  Ctrl-C, not a crash. `ensureIndexed` now extends the rule it already enforced — never
  answer from an index that was never built — to an index known to be half-built, and
  rebuilds it first, announcing itself on stderr before the work starts. This is the same
  repair `lore index` already performed; the reading commands no longer require the user
  to know they must run it.
- **A half-built index that cannot be repaired now says so.** On a read-only `.lore` the
  rebuild is impossible, so the CLI prints the caveat `stats` already used to stderr
  (stdout is untouched, so nothing parsing `lore search` moves), and `lore_context_pack`
  carries an additive `stats.indexIncomplete: true`. No other field or result shape changes.
- **A fact's provenance no longer changes when the index is rebuilt.** `lore assert` wrote
  the fact row before indexing the journal line it had just appended, so there was no block
  to point at and `block_anchor` went in NULL; `rebuildFactsFromNotes` replays that same line
  out of the indexed note and sets the anchor it finds. Any replay — deleting `.lore`, or
  simply re-indexing after an edit to an unrelated note — therefore moved every already-asserted
  fact's citation from `lore/journal/<date>.md` to `lore/journal/<date>.md#@0`, contradicting the
  README's "delete the index and rebuild it identically". The named test could not catch it: its
  projection selected seven columns and omitted the two provenance ones, so 120 generated
  histories passed over the only columns that diverged. `assert` now stamps the anchor from the
  journal note straight after indexing it, which is the same anchor the replay derives — on a
  journal split by headings both paths read `#<day>/Afternoon@0`, not a flattened path.
  **Visible change:** `lore facts` and MCP `lore_query_facts` now show the `#anchor` suffix
  immediately after an assert, where before they showed the bare path until the next rebuild.

## 0.37.2 — 2026-09-22

- **A note deleted since the last index no longer breaks every search.** 0.37.1's
  repair walks the paths already in the index and asks whether each is still a
  note; that question resolved the real file, which throws `ENOENT` for a path
  that is gone. Since the walk runs from `ensureIndexed`, one renamed or deleted
  note made `lore search` — and every MCP tool behind it — die with a raw errno
  naming an absolute path. The upgrade itself is when it would have fired, because
  that is when the walk always runs. A path that cannot be resolved is now simply
  not a note, and its stale row is dropped like any other. **0.37.1 was tagged but
  never published; use this instead.**

## 0.37.1 — 2026-09-15

- **An index built before 0.37.0 is repaired on the next open.** 0.37.0 narrowed
  what counts as a note, which stopped new leaks but did nothing about rows the
  older versions had already written. The incremental indexer only ever revisits
  files the scan still yields, and `ensureIndexed` only ran at all when the index
  was empty — so a vault indexed under 0.36.2 with a symlink named `*.md`
  pointing at a private key kept returning that key's contents from `lore search`
  after the upgrade, snippet and all, for as long as the user never ran
  `lore index` by hand. Opening the vault now drops every row the current
  definition would refuse to create, once, stamped in the index so it costs
  nothing thereafter. If you upgraded to 0.37.0, this is the release that
  actually cleans up.

## 0.37.0 — 2026-09-08

A note could run code at index time, and three things the engine was saying
that were not true.

- **Frontmatter can no longer execute code.** gray-matter ships a JavaScript
  frontmatter engine that is a bare `eval`, and picks the engine from the
  language written after the opening fence — so a note beginning `---js` ran
  arbitrary code the moment it was indexed. Vault notes are untrusted: shared
  vaults, synced folders, notes written by other agents. Dropping one markdown
  file into a watched folder was remote code execution. Every code-executing
  engine is now inert; such a note indexes as an ordinary note with a warning,
  its code is not indexed as prose, and YAML/JSON frontmatter are unchanged.
  If you run any earlier version against a vault you do not fully control,
  update.
- **`read_note` returns notes, and nothing else.** Path containment was
  checked; file type was not. A vault that symlinks in a folder — an
  attachments directory, a code repo, an ordinary Obsidian setup — exposed
  every file in it through `lore_read_note`, whatever its type and whether or
  not it had ever been indexed. The symlink exemption itself is deliberate and
  stays: the scanner follows those folders, so their notes are indexed and must
  be openable. But that reasoning only ever covered notes. `read_note` now
  applies exactly the scanner's condition, which `capture` has enforced on the
  write side all along.
- **One definition of "note", shared by the scanner, `read_note` and
  `capture`.** The three disagreed, and every disagreement leaked something.
  A symlink named `leak.md` pointing at `~/.ssh/id_rsa` was indexed, returned
  by search and served verbatim by `lore_read_note` — both gates looked at the
  link's name and then followed it. `read_note` served `.private/diary.md`,
  `node_modules/pkg/README.md` and `.lore/notes.md`, none of which the scanner
  ever indexes. And `capture --to .lore/x.md` reported success, was searchable
  for a moment, and was deleted by the next index as a note that had
  disappeared. All three now ask `whyNotNote` (exported): no hidden or ignored
  directory in the path, not engine-generated, a non-dotfile `.md` basename,
  and — for reading and indexing — a resolved target that is itself a regular
  `.md` file. A symlinked folder of genuine notes, and a symlink to a genuine
  note, are still indexed and readable. Behaviour change: a capture into a
  hidden, ignored or derived path is now refused with the reason, and a
  `.md`-named symlink to a non-note is no longer indexed.
- **`.lore/config.json` is honoured by every command that indexes.** `ignore`
  was read by nothing that indexes: the folders it named were scanned, indexed
  and searchable. `nlp: false` was overridden by the CLI flag's default of
  true, and MCP `lore_index` dropped `nlp` and `facts.extract` entirely. The
  first-run auto-index behind `lore search` used `ignore` only to decide
  whether the vault was empty. One helper now turns the config into index
  options and every entry point — `lore index`, `lore watch`, `lore_index`,
  the auto-index — spreads it first. Behaviour change: a vault with `ignore`
  set will report those notes removed on its next index, which is what the
  setting always claimed.
- **A read-only index still answers.** `chmod 444 .lore/index.db` — a vault
  on a read-only mount, a `.lore/` owned by another account, a backup opened
  in place — made every command fail with SQLite's raw "attempt to write a
  readonly database", including `search`, `facts`, `stats` and `timeline`,
  which only read. The schema stamp was upserted on every open whether or not
  it had changed, and each search wrote its results to the access log. The
  stamp is now written only when a migration ran, the access log is skipped
  on a read-only index, and when the directory itself forbids the `-shm` file
  WAL needs even to read, the index — with any un-checkpointed `-wal` beside
  it — is snapshotted to a temp file and read from there, so a backup copied
  while the engine was open reads correctly too. Commands that write — `index`, `assert`, `invalidate`,
  `capture`, `mark-used`, and their MCP tools — are refused up front with one
  line naming the file and that it is read-only, before a journal line or a
  captured note is written that the index could never see.
- **A fact key that normalises to nothing is refused everywhere.** A subject
  or predicate made only of emoji or punctuation normalises to the empty
  string, and every such claim landed in one shared slot: asserting `🚀` and
  then `—` reported the second as superseding the first, and invalidating
  `🎯` closed it. Both are refused now, on the CLI and over MCP, naming the
  value. The journal is replayed on every full re-index, so it is guarded
  there too — otherwise a line written by an older version would keep
  recreating rows that `invalidate` can no longer close. Rows an earlier
  version already stored under the empty key are left alone; a full re-index
  no longer recreates them.
- **An unreadable config is an error, not the defaults.** `loadConfig`
  treated every read failure as "no config file": a `.lore/config.json` that
  exists but cannot be read — a permissions slip, a directory in its place —
  silently fell back to defaults, so a vault configured for embeddings ran
  without them and said nothing. Only a missing file means defaults now;
  anything else stops with a line naming the file and the reason.
- **UTF-16 notes are indexed as text; a note that is not UTF-8 says so.**
  Every file was read as UTF-8 whatever it was. A UTF-16 note — what Notepad
  and PowerShell's `>` write by default — indexed with the title `utf16`, a
  first block of `EFBFBDEFBFBD23…`, not one searchable word, and no warning;
  a Latin-1 note lost every accented word the same way, in silence. A
  byte-order mark is now obeyed (UTF-16LE, UTF-16BE, UTF-8 with the mark
  stripped), `lore_read_note` decodes the same way, and when a decode still
  yields U+FFFD — or the text is riddled with NUL bytes, the shape of UTF-16
  without a mark — the note is indexed best-effort and `lore index` prints a
  warning naming the file and the reason. A UTF-16 note already in an index
  is re-read on its next change or on `lore index --full`.
- **Note text is sanitised before it reaches the terminal.** `lore search`,
  `ask`, `facts` and `timeline` printed note text and fact values verbatim, so
  a note holding `\x1b[31m…` or an OSC title-set `\x1b]0;…\x07` was carried
  out by the terminal that showed it: spoofed colours, a rewritten window
  title, and — on the same channel — cursor moves that overwrite earlier lines
  to fake a result, or a clipboard write on terminals that allow OSC 52. Every
  C0 and C1 control character except tab and newline now prints as U+FFFD, so
  the attempt stays visible instead of taking effect; CJK, emoji, combining
  marks and typographic punctuation are untouched. Display only: the index,
  the journal and `--json` carry the text exactly as written. The other
  commands that print note-derived text — `review`, `dream`, `resume`,
  `doctor`, `stats`, `count` — are not yet covered.
- **A date that cannot exist is refused.** `assertIsoDate` checked shape only,
  so `2025-13-01` and `2026-02-30` were accepted for `--since`, `--until`,
  `--as-of`, `--as-known-at` and `--valid-from`. Every comparison downstream is
  a lexical string compare, so an impossible date sorted as though it were
  real: it beat a genuinely later fact in supersession, persisted into the
  journal markdown a rebuild re-ingests, and came back as currently valid. The
  calendar check already guarded content dates; it now guards arguments too.
  Dates already stored are left alone.
- **`lore index` shows progress through the embedding pass.** It printed
  nothing from the moment parsing finished until the whole pass was done — 34.5
  seconds of dead terminal on a 2000-note vault, and linear from there. The
  project's own benchmark notes warn that a run silently waiting on a degraded
  provider looks identical to one that is merely slow; this is that case. Ticks
  go to stderr at most once a second, so stdout and `--json` are unchanged, and
  a run short enough not to need them stays quiet.
- **The MCP handshake reports the real version.** `serverInfo` carried its own
  hardcoded `0.35.0`, two minor versions behind the package, so every client saw
  the wrong number. The CLI had the identical bug and it was fixed in 0.36.2;
  the server kept a second copy of the same string. Both now read package.json.
- **Results name the signal that found them.** With zero term coverage both the
  CLI and the MCP server said "linked", without checking the dense score or
  whether the result had any links. In a vault with no links and embeddings on,
  a correct semantic hit was reported as a graph edge that does not exist.
  Ranking is unchanged; only the explanation is.

## 0.36.2 — 2026-09-06

Two correctness fixes, no behaviour change to retrieval.

- **`--version` reports the real version.** It printed `0.35.0` while the
  package was `0.36.1` — the string in `main.ts` was frozen at an old release.
  It is now resolved from `package.json` at runtime, so the CLI version cannot
  drift from the published one again.
- **All six npm advisories cleared without touching the MCP SDK.** `fast-uri`
  and `qs` are pinned to their first patched versions (3.1.6, 6.16.0) through
  an `overrides` block; npm's own suggested fix was to downgrade
  `@modelcontextprotocol/sdk` to 1.5.0, which would break the MCP server.
  Stated honestly: npm honours `overrides` only from a root project, so this
  protects this repository, its CI and anyone who clones it. Installing
  loreweave as a dependency resolves that subtree independently and is
  unaffected until the SDK bumps `ajv` upstream.

## 0.36.1 — 2026-08-26

MCP Registry publication, and a benchmark result that narrows an earlier claim.

- **Listed in the official MCP Registry.** Adds `server.json` (schema
  2025-12-11) and the `mcpName` ownership link the registry validates against
  the npm package, so loreweave is indexed by the registry that MCP clients and
  directories ingest from.
- **The embedding-model lever does not generalise to LoCoMo.** `mxbai-embed-large`
  against nomic on turn-level retrieval measured R@5 0.529 vs 0.532 and R@20
  0.707 vs 0.705 — noise in both directions, with rank 1 slightly worse. The
  swap worth +1.3 R@5 on LongMemEval and +1.5 nDCG on BEIR does nothing for
  single conversation turns; they are too short for the larger model to
  differentiate. The README, `evaluation.md` and the scoreboard now claim the
  lever at its measured scope — documents and sessions — rather than as a
  universal.

## 0.36.0 — 2026-08-18

Reliability of the embedding path, and first-class support for the models
that measure best.

- **Task prefixes for `mxbai-embed-large` and Snowflake Arctic.** Both are
  asymmetric retrieval models; without their trained query prefix they
  silently underperform. This is the release that makes the README's
  recommended model actually work as recommended — measured, the mxbai swap
  is worth +1.3 R@5 on LongMemEval and +1.5 nDCG on BEIR over nomic.
- **Embedding requests time out instead of hanging forever**
  (`embedding.timeoutMs`, default 120 s). A socket that died without closing
  — laptop suspended mid-index, container paused — used to leave the indexer
  waiting silently, forever.
- **Transient provider failures retry with exponential backoff**
  (`embedding.maxRetries`, default 2). Timeouts, dropped sockets and
  408/429/5xx retry; 4xx does not — a malformed request stays malformed.
  Every retry logs its reason, backoff and attempt, so a stalling server is
  distinguishable from a slow one. One transient stall no longer costs an
  hours-long index run.
- **Typecheck no longer requires the optional `@huggingface/transformers`**
  package to be installed (fixes CI-red-everywhere since 0.35.0).

Benchmarks, re-measured on the full sets this release (see
`docs/scoreboard.md`): LongMemEval_S R@5 **95.9%** on all 500 questions —
past the published BM25+vector hybrid (95.2%); BEIR/SciFact nDCG@10 **0.742**
with mxbai. README restructured around what users need first; the deep
evaluation record moved intact to `docs/evaluation.md`.

## 0.35.0 — 2026-08-15

Optional cross-encoder reranking — the fix for the one weakness every external
benchmark agreed on.

- **`rerank.provider: "transformers"`** (off by default) reorders the fused
  candidates with a cross-encoder, via an OPTIONAL peer dependency imported
  lazily: absent or broken, search logs once and returns the order it would
  have returned anyway. Measured on LoCoMo: overall **R@1 0.337 → 0.422**
  (+25% relative) and **multi-hop R@1 0.087 → 0.164**, taking the weakest
  category from 22% of its achievable ceiling to 42%. kestrel r@1
  0.400 → 0.575.
- **Skipped on temporally-scoped queries, deliberately.** A cross-encoder
  judges text against text and cannot see a date, so on "status in 2026" it
  ranks every passage about the subject alike and discards the evidence
  retrieval just used — meridian r@1 0.944 → 0.278 when allowed to overrule
  it. Gated, meridian is untouched and temporal flip-consistency stays 100%.
- **Costs, published rather than buried:** it sharpens rank 1 and scatters
  ranks 2-5 (northwind r@5 0.917 → 0.667); it costs 200-850 ms per query; and
  on BEIR it is nearly worthless (nDCG@10 0.681 → 0.688 for 45× the latency).
  A rank-sum blend that recovers the r@5 was measured and rejected because it
  gives up most of the r@1 that justifies the feature.
- **Two bugs found building it**, both worth naming. `tsup` was bundling the
  optional dependency, which broke its native ONNX binding — working from
  source, failing from `dist`, i.e. invisible in development and certain for
  every user of the published package; optional deps are now external. And the
  `text-classification` pipeline was the wrong API: it softmaxes over labels,
  and an ms-marco cross-encoder has one output, so every passage scored exactly
  1.000. Relevance is the raw logit.
- Also ruled out by measurement this cycle: **convex-combination fusion** over
  normalized scores (meridian r@1 0.944 → 0.444). Our boosts are multiplicative
  on the fused base and sized for RRF's compressed range; normalizing to 0..1
  lets a lexically dominant block outrun any boost, silently disabling the
  temporal machinery. Recorded at the fusion site. 429 → 432 tests.

## 0.34.0 — 2026-08-15

Pseudo-relevance feedback, and an honest read of the weakest number.

- **PRF as a fused channel.** Some questions are answered by one passage;
  others need the rest of a cluster. Rocchio's remedy, deterministically: take
  the terms that distinguish the top three hits from the vault, ask again, fuse
  the result *below* the user's own words (`weights.prf`, default 0.4). Guards
  against the drift PRF is famous for: it runs only on queries of four-plus
  terms whose best hit does not already cover everything; candidate terms must
  recur across the feedback set AND be rare in the vault; the expansion can
  only ever contain vocabulary the vault actually uses.
- **Measured, including where it does nothing.** BEIR/SciFact nDCG@10
  0.676 → 0.681 and Recall@10 0.811 → 0.817 — small, real, and exactly where
  the literature says PRF pays (verbose, recall-oriented queries). Flat on
  LoCoMo and on all three internal corpora, which is why it is gated rather
  than unconditional. Cost is one extra lexical pass on gated queries only
  (~15 ms).
- **The multi-hop number, read correctly.** LoCoMo multi-hop R@1 0.088 has
  been quoted as this engine's weak spot. Those questions carry 3.13 evidence
  turns on average, so R@1 there cannot exceed 0.390: the real figure is **22%
  of achievable, against 40-48%** for single-evidence categories. Still the
  weakest area — and PRF did not move it, which the README now says. The next
  measurement is whether embeddings bridge it. 425 → 429 tests.

## 0.33.0 — 2026-08-15

The embedding layer was being used wrong, by us. Fixed — and it goes from
harmful to the biggest single quality gain this project has measured.

- **Task prefixes.** `nomic-embed-text` is an *asymmetric* retrieval model:
  it is trained with `search_query:` on queries and `search_document:` on
  passages, and without them both sides land in the same region of the space
  and the dense channel stops discriminating. We were sending raw text for
  both. That — not embeddings themselves — is why 0.31.0 measured the optional
  layer making retrieval *worse* and why that finding is now retracted.
  Prefixes are inferred per model family (nomic, E5, BGE known; symmetric
  models get none) and overridable via `embedding.queryPrefix` /
  `documentPrefix`.
- **Measured, with prefixes sent:**

  | corpus | r@5 | MRR | answer shown |
  |---|---|---|---|
  | kestrel, model-free | 0.750 | 0.545 | 0.550 |
  | kestrel, + embeddings | **0.825** | **0.572** | **0.575** |
  | northwind, model-free | 0.917 | 0.690 | 0.833 |
  | northwind, + embeddings | **0.958** | 0.681 | **0.875** |

  And externally, on BEIR/SciFact: nDCG@10 **0.682 → 0.729**, Recall@10
  0.811 → 0.869 — from "competitive with BM25" to competitive with strong
  neural retrievers, using a small local model and no network.
- **Fusion weight left at 1.0 on purpose.** Sweeping 0 → 2.0, kestrel prefers
  2.0 and northwind prefers 1.0 — the corpora disagree, which is exactly what
  the second corpus exists to catch. Tuning to the winner would be overfitting
  the benchmark; the sweep is in `npm run eval -- --embed` for anyone who
  wants to tune to their own vault.
- The default is still **no models at all**. That guarantee is the product.
  This only means the optional layer now earns its place when switched on.
  421 → 425 tests.

## 0.32.0 — 2026-08-15

Measured on benchmarks we did not design — and fixed what that exposed.

- **Three external benchmark harnesses**, reproducible from
  [`docs/benchmarks.md`](docs/benchmarks.md): BEIR/SciFact (`npm run
  bench:beir`), LongMemEval_S (`bench:longmemeval`), LoCoMo (`bench:locomo`).
  All model-free — no LLM, no embeddings, no network — and all *retrieval*
  metrics, not end-to-end QA, so they are not comparable to the accuracy
  numbers systems with an LLM after retrieval quote.
- **The lexical core holds up externally.** SciFact nDCG@10 **0.682** for
  loreweave's lexical channel against the BEIR paper's published BM25 baseline
  of **0.665** — the FTS5 setup is competitive with Anserini, so the graph is
  not propping up a weak baseline.
- **LongMemEval_S session retrieval: R@5 0.899, R@10 0.943** overall, with
  knowledge-update at R@5 0.942 and temporal-reasoning at 0.871 — the two
  categories this engine claims. **LoCoMo turn-level recall: R@5 0.539**, its
  strongest category temporal (R@1 0.451).
- **Fix: the graph channel was trusted on vaults with no graph.** Entity-PPR
  backfill adds notes nothing else found — worth +13 to +25 points of reach on
  link-rich vaults, and pure noise without structure, where all that remains
  is co-occurrence over prose. A vault now has to *have* explicit structure
  (links, tags or facts — more than one per fifty notes) before the walk is
  trusted. Measured: SciFact nDCG@10 0.653 → 0.676, LoCoMo R@5 0.479 → 0.539,
  R@10 0.561 → 0.612; the internal corpora are unaffected. Not uniformly
  better: LongMemEval R@10 moved 0.955 → 0.943, and that is in the README too.
  Facts count as structure — the test suite caught a links-and-tags-only
  measure locking a fact-only vault out of its own fact edges. 420 → 421 tests.

## 0.31.0 — 2026-08-15

Measured the optional embedding layer for the first time — and it does not do
what this README has claimed since the eval existed.

- **New: `npm run eval -- --embed`.** Reruns all three corpora with local dense
  vectors (Ollama + `nomic-embed-text`) layered on, and sweeps the dense fusion
  weight. Everything published until now was the model-free FLOOR; nothing had
  ever measured the ceiling.
- **The ceiling is lower than the floor.** kestrel r@5 0.750 → 0.725 and MRR
  0.545 → 0.539; northwind r@5 0.917 → 0.833 and MRR 0.690 → 0.604; meridian
  unchanged. Sweeping the dense weight (1.0 → 0.5 → 0.25 → 0) does not recover
  it, and the loss splits between the dense ranking list and the similarity
  edges it adds to the graph. The README's claim that embeddings supply the
  semantics multi-hop needs is now replaced by this table and an explicit "we
  cannot claim the optional layer improves anything", with the caveat that
  synthetic corpora with invented vocabulary are the worst case for dense
  retrieval and a paraphrase-heavy real vault may differ — measure yours.
- **Reverted 0.29.0's SIMILAR deep-share.** That release gave similarity edges
  half weight past hop 1, reasoning that they are a claim about content and
  that a SIMILAR-only block otherwise scores 0. Both halves were true and the
  conclusion was still wrong: the eval could not run embeddings then, so
  nothing measured it. It can now, and deep=0 wins on all three corpora
  (kestrel MRR 0.539 vs 0.533, northwind 0.604 vs 0.570). Similarity is a
  statement about two blocks, not a chain of claims. The test that asserted
  the 0.29.0 behavior now documents the measured limit instead.

## 0.30.0 — 2026-08-15

Scale is measured now, and measuring it found a quadratic pass.

- **New: `npm run scale`.** The retrieval benchmark says whether answers are
  RIGHT; this says whether they arrive. Index time, incremental time, graph
  build, search p50/p95, the dream pass, and peak heap, over synthetic vaults
  of any size. Both claims the README makes are reproducible on your own
  machine now.
- **`dream` was quadratic in a vault's commonest entity.** `findLinkSuggestions`
  self-joins `mentions`, so an entity in K notes emits K²/2 pairs — and vaults
  have hub entities by nature (a project name, a person, a recurring tag). An
  earlier fix streamed the join, which bounded the MEMORY and left the work
  untouched. Measured: a 20 000-note vault did not finish the pass in ten
  minutes. Pair generation is now capped by document frequency, which is also
  the better semantics — an entity in more than √n notes is background, not
  evidence that two particular notes belong together (the same argument
  `entityIdf` makes for the graph), and those pairs were already being
  weighted to near-nothing by IDF *after* being generated at full cost.
  Dream on 1 000 notes: **1 967 ms → 226 ms**; 20 000 notes now completes in
  4.8 s.

Measured on the fixed build (reproduce with `npm run scale`):

| notes | full index | incremental | search p50 | p95 | dream | heap |
|---|---|---|---|---|---|---|
| 1 000 | 1.2 s | 32 ms | 3 ms | 4 ms | 0.2 s | 63 MB |
| 5 000 | 6.1 s | 165 ms | 9 ms | 12 ms | 1.0 s | 145 MB |
| 20 000 | 22.5 s | 656 ms | 38 ms | 53 ms | 4.8 s | 333 MB |

Full index scales at 0.93× per note from 5 k to 20 k — linear or better.
419 → 420 tests (the new one guards the blowup, not a millisecond budget).

## 0.29.0 — 2026-08-15

The audit's last substantive batch — two of them broke the promise the whole
engine rests on.

- **Search order depended on index build history.** Exact PPR ties are
  ordinary vault structure (two notes tagged the same way), and ties fell
  through to graph node index → block rowid → insertion order. A byte-identical
  vault returned `hub, alpha, beta` from a fresh index and `hub, beta, alpha`
  from an incremental one. Graph nodes are now ordered by content
  (`note_path, anchor`; entities by key), with an explicit tie-break on the
  rank sort. Fixing it at the node level covers every consumer, not just the
  sort that exposed it.
- **`timeline` had the same disease.** Its comparator never returned 0 and
  disagreed with itself on same-kind ties, and the mention query ordered by
  date alone — so same-date entries came back in row order. Now a total order
  keyed only on content.
- **`timeline` couldn't merge plural-named entities.** Prose mentions are
  keyed through `singularizeKey`, fact subjects are not — so "Redwood Systems"
  had its facts under one key and its mentions under another, and the merged
  history the command exists for was unreachable under every spelling.
- **Persisted SIMILAR edges could never terminate mass.** Since 0.23.0 they
  carried zero weight past hop 1, so a block reachable only by embedding
  similarity — precisely the vocabulary-disjoint case those edges exist for —
  scored exactly 0. They now carry half weight at depth: weaker than a stated
  link, no longer a dead end.
- **The decay fit trusted inflated labels.** One `used` marked *every*
  retrieval in the prior week a success, so a block cited weekly scored ~100%
  recall and the optimizer fitted inter-event cadence rather than memory — and
  a resulting 0.1 fit pushes retrievability so flat that `lore review` could
  never surface a block again. Each use now credits at most the nearest
  preceding retrieval.

Eval note: the shipped hybrid pipeline is unchanged on every metric across all
three corpora; the graph-only diagnostic moved (ans@5 4/24 → 2/24 on northwind)
because its ties now break deterministically instead of by luck of insertion
order. Baseline re-recorded. 414 → 419 tests.

## 0.28.0 — 2026-08-15

Five more audit findings — the batch where a typo could tell you your vault
was healthy.

- **`lore review --limit x` printed "nothing is fading" and exited 0.** Bare
  `parseInt`/`parseFloat` let a typo through as NaN, and every comparison
  against NaN is false — so a mistyped flag silently disabled the check it was
  meant to tune and returned an affirmative all-clear. Same shape on
  `--threshold`, `search -k`, `assert --confidence`, `watch --debounce`. All
  numeric flags now reject non-numbers and out-of-range values (exit 1 with
  the offending value named), matching the zod bounds the MCP layer already
  had.
- **Identity edges could merge unrelated things.** The acronym layer built
  initials from *every* word, so "The Old Mill" spelled `tom` and merged into
  a person named Tom at full same-as weight — deep-propagating, and
  indistinguishable downstream from a stated fact. Initials now skip
  stopwords, and the target must actually look like an acronym in the vault
  (`MTS` still merges with Motherson Technology Services).
- **`aliases: Bobby` (scalar YAML) made no alias at all.** The graph layer
  coerced the scalar form; the extractor only read arrays — so the entity
  never existed and the edge the graph was written to build silently never
  appeared. Both layers agree now.
- **Synonym rings were asymmetric.** Rings sharing a word merged only into
  that word's entry: dead `boss` reached `lead`/`led`, while its own declared
  synonyms `supervisor` and `manager` reached nothing. Which word you happened
  to type decided whether routing worked. Rings now merge transitively for
  every member.
- **Editing a note erased its access history.** `access_log.block_id` is
  `ON DELETE SET NULL` and every edit deletes all of a note's blocks — so one
  edit wiped the retrieval/use events of blocks whose text never changed and
  whose stability is carefully carried over. FSRS decay-fitting trains on
  exactly those events, so the vaults you actually work in trained on the
  least data. History now follows a surviving block to its new row.
  409 → 414 tests.

## 0.27.0 — 2026-08-15

Two more audit findings, both attacking the same promise: **outputs are a
function of the vault, not of index build history.**

- **HIGH — the fact replay stamped wall-clock time into the record.**
  `rebuildFactsFromNotes` wipes and replays the whole fact table on every
  index that touches any note, and a `- [fact]` line in a plain note with no
  date fell back to `new Date()`. So editing an *unrelated* note re-dated the
  fact: `recorded_at` moved, `--as-known-at` answers shifted, an undated
  `- [invalidate]`'s close drifted (changing `--as-of` answers), and `resume`
  announced facts nobody had asserted — every edit, forever, under watch mode.
  Replay now uses the source note's mtime, which is what the structured
  extractor two functions away already did. Replay is idempotent again.
- **HIGH — parser upgrades never reached already-indexed notes.** The indexer
  skips a file whose mtime, size and hash all match, and nothing tracked what
  the *parser* knew — so 0.20.0's prose dates and 0.24.0's H1 titles applied
  only to notes that happened to change afterwards. Two identical vaults gave
  different answers depending on which versions had indexed them. A
  `PARSER_VERSION` stamp now clears note fingerprints on mismatch (migration
  v5's move, driven by the parser's version rather than the schema's), so the
  next index reparses. Vaults indexed by any earlier release heal on first
  open — expect one full reparse after upgrading, then nothing. 406 → 409
  tests.

## 0.26.0 — 2026-08-15

Three defects found by an adversarial audit of everything shipped since
0.10.1 — the first audit of that surface, and the first one where the loudest
finding was silent data loss.

- **HIGH — `resume` permanently lost edits made while the index was stale.**
  The delta reports what the INDEX knows, but the watermark advanced by the
  WALL CLOCK. Edit a vault in an editor with nothing indexing (no `lore
  watch`), then start a session: the edit is invisible (the row still carries
  the old mtime), the watermark moves past the file's real mtime anyway, and
  once the index catches up that mtime sits below the watermark forever — the
  edit appears in no delta, ever. Notes are now tracked in file-mtime space
  (`resume_notes_mtime`), which cannot outrun what the index has seen; facts
  keep the wall-clock watermark, which is what `recorded_at` actually is.
  Existing vaults seed the new watermark from the old one, so nobody
  re-reports their whole vault once.
- **HIGH — the recency cue over-claimed on stale vaults.** Min-max
  normalization is purely relative: one distinct date in the candidate pool
  scored a flat 1.0, so a lone 2019 journal took the FULL "current status"
  boost and outranked the undated page that states the current status. Now:
  one distinct date means nothing to prefer it over, so no claim; otherwise
  the min-max rank is scaled by absolute age, making "newest of several
  ancient things" a weak claim rather than a maximal one. The feature still
  works — meridian's temporal categories are unchanged (1.000/1.000/0.75).
- **MEDIUM — `boosts.temporal: 0` inverted windowed "current" queries.** The
  cue keyed off the config-gated window rather than the query's own words, so
  disabling temporal emphasis made "current status in 2019" prefer the
  NEWEST block — actively wrong rather than merely neutral. The query's
  window is now read once, independent of config. 402 → 406 tests.

## 0.25.0 — 2026-08-12

Hard queries get the deep walk; easy ones stay fast.

- **Query-adaptive expansion depth (the QPP routing).** A DEAD content term —
  a plain word with zero hits in this vault — is the classic pre-retrieval
  hardness signature: the user is describing the vault in words the vault
  does not use, which is exactly when a one-hop walk starves. Those queries
  now get the two-hop walk automatically; ordinary queries keep the fast
  shallow one, and windowed/counting queries stay with the temporal and
  computable layers that own them. Measured, this beat both fixed settings:
  kestrel reach 97.5% → **100%** (the last multihop MISS found), northwind
  r@5 87.5% → **91.7%** with a stuck aggregate question rising 16 → 5,
  MRR up on both, meridian untouched. The v0.24.0 knob measured the trade;
  the router keeps both sides of it. 401 → 402 tests.

## 0.24.0 — 2026-08-12

Chains of claims order the backfill — and H1-titled vaults come alive.

- **Path-reliability ordering (the PathRAG-shaped fix).** Recall-reached
  notes were ordered by raw PPR mass, which counts texture — so a two-hop
  answer at the end of a link chain sat behind one-hop co-occurrence
  bystanders. A second walk restricted to relational edges (links, facts,
  identity, mentions — v0.23.0's weightsDeep) now scores whether a CHAIN OF
  CLAIMS reaches each note, and that score orders the backfill. On windowed
  queries the ordering is suspended: temporal evidence outranks path
  reliability. Measured: kestrel multihop r@5 0.3 → 0.4, MRR 0.117 → 0.145
  (+24%), northwind and meridian exactly at baseline.
- **H1 titles resolve.** A vault titled by H1 headings with slug filenames —
  docs repos, blogs, half of real vaults — had a DEAD link-expansion channel:
  `[[Transect Plan]]` could not resolve to `transect-plan-notes.md` because
  titles came only from frontmatter or filename. The first H1 now titles the
  note (frontmatter still wins; the filename stays an alias), which wakes
  link resolution, note-name seeding, and expansion for that entire vault
  shape. Found while writing this release's test, on a five-note vault.
- `retrieval.expansionHops` documented: 2 reaches every two-hop answer on
  the eval (multihop found 100%) at a measured precision cost in dense
  vaults; the default stays 1. 400 → 401 tests.

## 0.23.0 — 2026-08-12

Texture stops at hop one.

- **Provenance-tiered deep propagation.** Every graph edge now carries two
  weights: the full one, and the share allowed to keep propagating past the
  first hop. Relational evidence travels — links, facts, identity, mentions;
  co-occurrence and embedding similarity are neighborhood texture, and
  compounding texture across hops is how a walk drowns a two-hop answer
  under a one-hop wall (the same pathology the co-occurrence dilution
  comment has documented at hop 1 since it was measured). PPR's first
  iteration walks the full graph; deeper iterations walk only what a claim,
  not a coincidence, supports. Honest ledger: small positive drift on the
  eval (kestrel MRR 0.540 → 0.541, multihop 0.115 → 0.117), zero movement
  elsewhere, gate green — the structural guarantee is the point, and it
  compounds with fact edges as vaults accumulate asserted relations.
  398 → 400 tests.

## 0.22.0 — 2026-08-12

Questions use vocabulary ABOUT a vault, not from it.

- **Controlled-vocabulary rings for dead query terms.** "Ridge Array
  benefactor" hit zero notes while the vault said "funded by [[Meridian
  Trust]]" — the relation was present under a different surface form, and no
  vault-derived statistic can bridge that (there are no co-occurrences to
  derive it from). A small shipped table of relation/type synonym rings now
  routes DEAD terms only (df = 0 in this vault) to ring-mates that DO occur
  here, feeding just the lexical channel — coverage, entity matching and the
  dense query stay the user's literal words. A shipped table is data, not a
  model (a stemmer table's standing; Falcon 2.0 has done rule-based relation
  linking over alias tables for years) — the core stays reproducible and
  model-free. Honest ledger: one eval multihop question rose (rank 11 → 6),
  others washed; the benchmark's density dilutes expansion in a way small
  real vaults do not. 394 → 398 tests.

## 0.21.0 — 2026-08-12

The graph now knows what the fact store knows.

- **Fact edges.** "Brasshold :: funder :: Quill Trust" lived in the fact
  store while PPR walked mention and co-occurrence edges around it — the
  strongest relational evidence in the vault sat outside the graph. Every
  currently-valid fact now contributes a subject ↔ object entity edge
  (`edgeWeights.FACT`, default 1.0, the highest — a stated relation is not a
  co-occurrence guess). Superseding a fact removes its edge: the walk ranks
  the present. Payoff pinned by test: searching "Brasshold programme
  backing" reaches the funder note that never mentions Brasshold. Honest
  ledger: the eval corpora did not move — their multihop chains are prose
  links, not fact chains — this is for fact-rich vaults and agent-asserted
  memory, and it lays the rail for predicate-aware routing (researched, next).
- **Embeddings dogfooded end-to-end** (Ollama + nomic-embed-text, 474 blocks):
  the dense channel works, and honesty compels a correction — on
  relation-tracing multihop queries embeddings do NOT rescue ranking (the
  answer note shares no topic text with the query; only the graph knows).
  Current theory agrees: fixed-embedding retrievers provably need
  embedding width proportional to graph size for relation tracing
  (SeedER, arXiv:2605.23753). The README's framing will be updated as the
  predicate-routing work lands. Also new: demo GIF in the README.
  391 → 394 tests.

## 0.20.1 — 2026-08-12

Dogfood pass on a real vault (42 notes of career records, tables, leads).

- **Timeline mentions show the line naming the subject** — a table block's
  first line is "| Skill | Proficiency |", unreadable as a history entry;
  the same lesson `bestSnippet` taught search now applies to `timeline`.
- Verified on real data: "companies to avoid" search hits the exact passage
  at rank 1; dream's duplicate/link/orphan findings are sensible; resume
  delta correct. Diagnosed and closed the kestrel multihop tail: ranks 11-24
  are one-hop walls in front of two-hop answers whose discriminating word
  ("benefactor", "hardware") appears in zero vault notes — the documented
  embeddings frontier, not a ranking bug.

## 0.20.0 — 2026-08-12

Content time now reads the dates people actually write.

- **Prose dates in human form.** "The role passed to Halvorsen in June 2023"
  indexed as *undated* for as long as the engine existed: the query parser
  understood month-year, but the content side extracted only ISO dates — so
  on real vaults most of the temporal machinery (window boost, recency,
  timeline mentions) never fired. `extractDates` now reads "June 2023"
  (whole-month range), "14 June 2023", and "June 14, 2023". Bare years stay
  ignored on purpose: "Room 2019" is not a date. Found by probing an eval
  failure cluster — six temporal questions found the right note but the
  history block that answers them was invisible to every temporal signal.
- **Timeline: mined attributes are descriptions, not events.** A frontmatter-
  extracted fact with no valid time (`type: station`) appeared as a "change"
  dated whenever the index ran — one line of today-noise per hub page.
  Stated facts keep their entry: asserting IS an event. 389 → 391 tests.

## 0.19.0 — 2026-08-12

Word order is evidence: term-proximity joins the ranking.

- **Sequential-dependence proximity signal.** "ledger migration" as a phrase
  and the same two words a paragraph apart were indistinguishable to
  coverage; now the fraction of the query's adjacent term pairs preserved in
  a block boosts its score (`boosts.proximity`, default 0.1) and breaks ties
  when choosing which block of a note to show. The weight was set by
  measurement, not taste: 0.2 flipped one kestrel near-tie the wrong way,
  0.1 keeps kestrel exactly at baseline while lifting northwind MRR
  0.664 → 0.685 with meridian unchanged — the sweep is the point of having
  three corpora. Zero dependencies, no index changes (Metzler & Croft 2005's
  lesson, applied at reranking cost only). 387 → 389 tests.

## 0.18.0 — 2026-08-11

`lore review` — the spaced-repetition loop, operable on demand.

- **New command + MCP tool (`lore_review`).** Important-but-fading knowledge:
  blocks whose retrievability has decayed below the threshold despite
  mattering, plus long-untouched open facts — sorted most-at-risk first,
  computed from the vault's own fitted forgetting curve (0.17.0). The loop
  closes with `mark-used`: review the list, reinforce what still matters,
  and it stops surfacing — use is what feeds stability, so the queue is
  self-clearing. The threshold is a parameter (`--threshold`, default 0.3).
  `dream` and `review` share one definition of "fading" (the same exported
  detector), so the idle pass and the on-demand surface can never disagree.
  No other vault tool ships this deterministically. 384 → 387 tests;
  15 MCP tools.

## 0.17.0 — 2026-08-11

The forgetting curve is now the vault's own, not a hard-coded guess.

- **FSRS-6 trainable decay, fitted per vault.** Retrievability was pinned to
  the FSRS-4.5 shape (decay 0.5); FSRS-6's headline change is that the curve
  SHAPE is a parameter, and it predicts recall better than the fixed shape
  for 88% of users on the open 700M-review benchmark. `lore dream` now fits
  the decay from the vault's own history — each retrieved-then-used event is
  a success, retrieved-and-ignored a miss, stability replayed per block, log
  loss ranks candidate shapes — and stores it for every retrievability
  consumer (search boosts, importance, stale detection). The invariant
  R(S,S)=0.9 holds for every shape, decay 0.5 reproduces the old constants
  to floating-point precision (existing vaults rank identically until a fit
  says otherwise), and thin history (<50 events) refuses to fit rather than
  fitting noise. Everything derived, rebuildable, zero LLM. 376 → 384 tests.

## 0.16.0 — 2026-08-11

Same-as edges: one thing under several names is one graph node's worth of
reach, not three.

- **Alias and acronym identity edges in the entity graph.** A person is "Bob"
  in standups, "Robert Aldana" on their hub page; a company is both
  "Motherson Technology Services" and "MTS". Those arrived as disconnected
  entity nodes, and activation from one never reached content filed under the
  others — HippoRAG's ablation prices exactly this edge class at 3.5 R@5
  points, on a corpus with better name hygiene than any vault. Two
  deterministic layers: the note's own frontmatter `aliases:` list (the
  Obsidian convention), and acronym ↔ expansion pairs (initials of a
  multi-word entity spelling another entity key; two-letter initials are
  ignored — collisions, not identity). Both are identity claims rather than
  co-occurrence evidence, so they carry a high weight (`edgeWeights.SAMEAS`,
  default 0.9). Searching "Bob dredge calibration" now reaches the note that
  only ever says [[Robert Aldana]]. 372 → 376 tests.

## 0.15.0 — 2026-08-11

"What is the status NOW" finally ranks the newest account first.

- **Recency preference for now-phrased queries.** A query with a present-tense
  cue ("current status", "where does X live now", "latest") names no window,
  but its tense does: the newest account is the answer, and lexically the
  entity's whole history ties. Recency is min-max normalized over the DATED
  candidates in the pool — newest gets the full boost, oldest none, so it is
  scale-free across vaults whose changes span a decade or a month. Undated
  blocks stay neutral (mtime is when a file was touched, not when its events
  happened), record blocks are the log rather than the account, and a dated
  window in the query wins over the cue ("current status in 2024" is a 2024
  question). New `boosts.recency` config (default 0.3, 0 disables).
- Measured: meridian `current` r@1 **0.25 → 0.75**, corpus MRR 0.883 → 0.952,
  with temporal and flip categories still at 1.000 and zero regression on the
  other corpora. The residual miss is honest vocabulary mismatch — a 2023
  note literally claiming "infrastructure now runs at Foxglove" outscores the
  newer note that avoids the query's words; that is embeddings territory, not
  a ranking bug. 371 → 372 tests.

## 0.14.0 — 2026-08-11

`lore resume` — session continuity as a query, not a paraphrase.

- **New command + MCP tool (`lore_resume`).** "What changed since this agent
  last connected": notes edited, facts asserted, and knowledge updates
  rendered as the changes they are ("status: planning → active") — computed
  from record time, so the same watermark always yields the same delta. The
  implicit call consumes the delta (advances the watermark); an explicit
  `--since` is a pure read that never eats the next session's continuity.
  First contact defaults to a week of context. The popular alternatives run
  an LLM over the previous session at shutdown and inject the paraphrase;
  this is the same capability with zero LLM, reproducible, and correct
  exactly when the paraphrase would not be. 367 → 371 tests; 14 MCP tools.

## 0.13.0 — 2026-08-11

Facets: search can now be scoped by tag and folder.

- **`--tag` / `--folder` on `lore search`, `tags`/`folder` on `lore_search`.**
  Every listed tag must be on the note (frontmatter and inline `#tags` count
  alike; case and the `#` are forgiven); a leading `-` excludes ("#decision
  notes that are not #archive"); `--folder projects/` scopes to a vault
  subtree. Facets are membership, not emphasis — unlike the temporal boost,
  an out-of-scope note is out, however well it scores — and they filter the
  whole candidate pool before the k-cut, so in-scope results are never
  crowded out by out-of-scope ones. An over-constrained scope returns empty,
  not noise. This was the most-repeated complaint across competitor issue
  trackers (include-whitelists, type filters); 362 → 367 tests.

## 0.12.0 — 2026-08-11

`lore timeline` — an entity's whole history in one call.

- **New command + MCP tool (`lore_timeline`).** Merges the two records the
  engine keeps and no single query could see together: the bitemporal fact
  store's supersede chains, rendered as change-points ("status: planning →
  active", with what each value replaced and when it stopped holding), and
  content-dated blocks mentioning the entity — the prose record, verbatim,
  placed at when it happened. Windowed with `--since/--until`; `--json` for
  machines. "What happened to X" / "what was X before it changed" used to
  take `facts --history` plus repeated windowed searches merged by hand —
  and the systems that market that exact query pay an LLM at ingestion to
  build the change graph the supersede chain already holds. Here it is a
  read-side join: no LLM, no network, reproducible.
- Journal record blocks (`- [fact] …` lines) are excluded from the mention
  stream — they are the WRITE that produced a change entry, and echoing them
  narrated every change twice. 362 tests (+6).
- CI note: the suite is green on Windows for the first time — a containment
  test had been comparing path separators instead of containment since the
  workflow existed (test-only fix, shipped untagged).

## 0.11.1 — 2026-08-11

A third eval corpus that measures TIME — and the three refinements it forced
on 0.11.0's temporal boost within the hour of existing.

- **New corpus: meridian.** Facts change across dated notes (status flips,
  office moves, vendor and licence changes); dates live only in frontmatter,
  invisible to BM25. Categories: `temporal` (windowed queries — hybrid r@1
  **1.000 vs BM25 0.000**), `flip` (TempRAGEval-style perturbation pairs: the
  same question with a shifted window has a different correct answer — hybrid
  **1.000 vs 0.167**), and `current` (knowledge-update; hybrid 0.25 r@1,
  recorded as honest headroom — retrieval has no content-recency preference
  yet). Now part of the regression gate.
- **Correction: 0.11.0's "both eval corpora unchanged" was measured against a
  stale build** — the gate was invoked directly instead of through the npm
  script that rebuilds first. Freshly measured, the flat boost regressed
  kestrel (r@5 0.75 → 0.70, MRR 0.54 → 0.514). This release fixes the
  regression properly rather than papering it:
  - **Rarity scaling** — temporal evidence is only as strong as it is rare
    (the entityIdf logic applied to time): the boost divides by
    1 + log2(in-window candidates), so "one note dated that June" is a strong
    signal while "every 2022 log matches" distinguishes nothing.
  - **Fact valid-time is temporal evidence too** — an undated hub page whose
    superseded facts were valid inside the window is boosted like a dated
    journal entry; reference-style vaults keep history on hub pages and got
    demoted by a prose-date-only boost.
  - **Record blocks are never boosted** — a block of `- [fact]` lines is the
    log of assertions, not content about a period (RECORD_LINE's reasoning),
    and counting questions ("how many traverses ran in 2022?") skip the boost
    entirely: their window scopes the aggregate, which the computable layer
    owns.

  Result: kestrel fully restored, northwind improved (hybrid−BM25 MRR gap
  +0.122 → +0.143), meridian's wins intact. Baseline re-recorded over all
  three corpora.

## 0.11.0 — 2026-08-09

Search now honours the time window a query itself names. Grounded in a
six-probe research sweep over current memory/retrieval literature (LongMemEval,
TempRALM, MRAG, Mem0, Zep, HippoRAG 2) — which also confirmed loreweave already
ships the graph mechanisms those papers ablate as most valuable (IDF-weighted
PPR seeds, hybrid entity+block seeding, co-occurrence edges).

- **Query-derived temporal scoping.** "ledger work in March 2025" now lifts
  content *dated* March 2025; before/until/after/since words produce one-sided
  windows ("meetings before Q3 2026"). It is a soft boost, never a filter — a
  query naming a year is not always about that year, so it decides emphasis,
  not membership, and reach cannot regress. Only blocks with a REAL content
  date are boosted: mtime says when a file was touched, not when its events
  happened. An explicit `--since/--until` is the caller's temporal intent and
  disables query-text scoping. Literature: LongMemEval measures +6.8–11.3%
  recall for exactly this; temporal reasoning was Mem0's largest 2026 gain and
  is where agent-memory products differentiate. New `boosts.temporal` config
  (default 0.3, 0 disables). 352 → 356 tests.

## 0.10.1 — 2026-08-09

Two CLI-validation gaps the same audit surfaced but did not rank into its
verified top six — both let a malformed argument produce a confidently wrong
answer instead of an error. Fixed at the core functions, so the MCP tools are
covered too, not just the CLI (350 → 352).

- **`count --group-by X` leaked a raw SQL error.** An unknown group-by column
  arrived from the CLI unchecked, indexed to `undefined`, reached SQLite as
  `GROUP BY undefined`, and surfaced as "no such column: undefined" — an
  internal error masquerading as the user's mistake. It now rejects by name,
  listing the valid columns.
- **`search --since/--until` silently mis-filtered a malformed date.** The window
  is a string comparison, so `--since not-a-date` sorted by ASCII accident and
  returned "no results" as if the vault were empty. A bad date is now a hard
  error, the same way the fact store already validates `--as-of`. A shared
  `assertIsoDate` is the single source of truth for all three.

## 0.10.0 — 2026-08-09

Six correctness defects found by a fan-out audit — seven probes across surfaces
the incremental work had not stress-tested, then an adversarial pass that tried
to *refute* each candidate by running code. Twelve candidates, six survived
refutation, none were false positives. All fixed with regression tests
(339 → 350).

- **HIGH — interrupted-index self-heal was defeated by an own-PID marker.** A
  mid-loop throw leaves `index_in_progress` holding the crashing process's PID;
  `process.kill(self, 0)` always succeeds, so the next index in that *same*
  still-alive process read it as "running", never rebuilt the half-built
  facts/mentions, and then cleared the marker so no later run could self-heal.
  It bit the two long-lived callers, `lore watch` and the MCP server. Fixed with
  an in-process in-flight flag; the old test only ever used a foreign dead PID.
- **Frontmatter date shadowed every block's own prose date.** `extractDates`
  returns on the first frontmatter hit, so a note with any frontmatter date
  stamped *all* its blocks with it — a `--since/--until` window then dropped the
  block whose prose dates the event. Block prose dates win now.
- **Phantom graph links from inside split code fences.** An oversized fenced
  block is chunked past its opening ```, so `maskCode` could no longer blank it
  and a `[[link]]` inside a code sample became a real edge. Fence state is
  carried across chunks.
- **`singularizeKey` shredded `-es` proper nouns** (James→jame, Jones→jone,
  Naples→naple), splitting each from its own `[[wiki-link]]` into two graph
  nodes. Dropped the `/es$/` branch that contradicted the rule's own comment.
- **A past-dated question with no past-tense verb** ("where did I live in
  2023") was answered with today's facts; it now scopes to the window end, like
  its past-tense twin already did.
- **A `~~~` line inside a ``` fence** mis-toggled fence state, promoting code
  lines to headings; `splitSections` now tracks which delimiter opened the
  fence.

Three existing tests asserted the old behavior and were corrected on their
merits. Both eval corpora unchanged.

## 0.9.2 — 2026-08-08

- **The README's example outputs match the real ones again.** Ran every
  `$ lore` example verbatim against a scratch vault. Most match exactly; three
  had drifted: the search example still showed the `#Standup@0` anchor display
  replaced by `› Standup` many releases ago — a reader comparing their real
  output against the README's would conclude their install was broken — and the
  `assert`/`--as-of` examples omitted lines the commands print. A conformance
  test now fails on the dead format.

## 0.9.1 — 2026-08-08

- **The MCP server watches the vault.** `lore serve --mcp` runs for a whole
  session with the user's editor open beside it, and it never watched — a note
  saved in Obsidian mid-session was unfindable over MCP, indefinitely, with
  nothing to say so. This is the exact scenario the watch module's rationale
  describes ("a question an agent cannot think about at all"), and the one
  long-running process was the one place it was not wired in.

  `startMcpServer` attaches `watchVault` for the life of the process and closes
  it on every exit path. All the 0.4.4 watcher hardening applies: the three
  editor save patterns, and the max-wait ceiling for vaults under continuous
  sync. Verified in-process and over a real stdio transport.

Interactions checked rather than assumed: a `capture`/`assert` now triggers
both its self-index and a watch reindex — the second sees matching mtime/size
and reports unchanged; `dream --apply`'s outputs are already filtered by the
watcher, so no reindex loop.

## 0.9.0 — 2026-08-08

- **What the engine writes is searchable the moment it writes it.** The natural
  agent sequence — record something, then look for it — silently failed:
  `capture` then search found nothing, `assert_fact` then search found nothing,
  both until the next `lore_index`. The previous release documented that trap
  in the tool description; documenting a trap is what you do when you cannot
  remove it, and both tools know exactly which file they appended to.

  `capture`, `assertFact` and `invalidateFact` now index the single file they
  wrote — the same per-note work the indexer does, so the next incremental run
  sees matching mtime/size and correctly skips it. The consistency test asserts
  the strong form: after self-indexed writes, the next full index reports
  **zero** changes *and* the store equals a fresh build of the same bytes,
  blocks and facts both.
- **`lore_index`'s contract updated in the same commit** — it is for writes
  made outside `lore_*` tools; the `lore_*` write tools handle their own. The
  caveat added last release became stale the moment this landed, which is
  exactly the drift that release was about.

Two guards worth noting: the identical-assertion path still self-indexes (the
journal line is appended even when the fact is a no-op), and a derived note
(e.g. capturing to `lore/review-queue.md`) is never self-indexed, since a full
rebuild would delete it — a transient violation of the disposability property.

## 0.8.4 — 2026-08-08

- **The MCP tool contracts describe what the tools do now.** Descriptions are
  the contract an agent reads, and an agent cannot notice when one is stale.
  Two had drifted in exactly the shape this project keeps finding in its data —
  a silent cap:

  - `lore_aggregate_facts` returns `{ groups, totalGroups, limit }` and caps at
    100 groups since 0.6.0; its description mentioned neither, so "how many
    distinct X" would be answered by counting `groups` — i.e. 100. It now says
    to read `totalGroups`, **and the schema gained the `limit` parameter** it
    refers to.
  - `lore_context_pack`'s description now explains the `truncated` field: treat
    a missing item as "not in this sample", never as "not in the vault".

  Plus three smaller drifts: `dream_report` no longer claims to be read-only
  (index maintenance runs either way; results are unchanged), `capture` states
  its symlink containment, and `lore_index` names the write tools whose output
  is not searchable until it runs.

Contract tests pin the big two — including that raising `limit` actually
returns more groups, not merely that the description claims so.

## 0.8.3 — 2026-08-08

- **`graph export` is byte-identical whether the index was grown or rebuilt.**
  Node order came straight from an unordered `SELECT`, so it followed row
  order, which follows edit history — the same vault produced a different file
  depending on how its index was built. These are files people diff and commit,
  which is the whole reason the format exists. Notes, entities, mentions and
  link edges are all ordered now.

That completes the sweep the last two releases started: every user-visible
output — search answers, the review queue, the digest, and all three export
formats — is now a function of the vault rather than of its index's history.

## 0.8.2 — 2026-08-08

- **`dream` writes the same review queue whether the index was grown or
  rebuilt.** Yesterday's fix made search answers a function of the vault;
  `lore/review-queue.md` was not, and it matters more there — that file goes
  into the vault, and people keep vaults in git, so an unchanged vault could
  still produce a diff you have to read to learn it says nothing.

  Three causes: findings tie constantly (every exact duplicate scores 1) and
  fell through to row order, which follows edit history; a duplicate *pair* had
  an orientation, so the same finding could be written either way round; and a
  group of identical blocks emitted its pairs against whichever member came
  first, so twelve identical notes gave one run n0 as the anchor and the other
  n1 — a different set of findings, not just a different order.

  Duplicates, link suggestions, contradictions, stale items and orphans now all
  order deterministically, pairs are canonicalised, and the rows are sorted
  before any of it runs.

Fact ordering was checked in the same pass and is stable, live and replayed.

## 0.8.1 — 2026-08-08

- **Deleting the index no longer changes the answers.** The disposability claim
  has been property-tested for three releases at the level of database tables —
  an incremental index equals a rebuild, row for row. That comparison orders
  rows by path, which normalises away the one thing that differed.

  Block ids are autoincrement, so an index grown through edits numbers its rows
  nothing like a fresh one (measured: 4..91 against 1..30 for the same 30
  blocks), and ties fell through to that order. Comparing **answers** instead
  of tables, 3 of 6 queries came back different for identical vault bytes — the
  incremental index returning only the notes that had never been edited,
  because those kept low ids.

  Two places: the lexical query ordered by BM25 alone, and with `LIMIT` that
  decides which blocks become candidates at all; the final ranking then relied
  on `Array.sort` being stable, preserving the same order. Both now break ties
  by note path and anchor.

Both eval corpora unchanged, as expected — the benchmark indexes each corpus
once, so it never had two build histories to disagree about.

## 0.8.0 — 2026-08-08

- **`graph export --out` no longer silently overwrites.** Audited every write
  in the source: six are append-only or live under `lore/` and are regenerated.
  The seventh took a path the user typed and wrote it unconditionally, then
  printed `wrote notes/atlas.md`. A typo — or a moment's inattention about
  which file was which — destroyed the note and reported success. It now
  refuses unless `--force`.

  The vault is the source of truth, so destroying part of it is the one error
  this engine cannot walk back: an index rebuilds, a note does not.
- **`dream`'s writes are contained.** Its digest and review queue joined paths
  directly, so a symlinked `lore/` would have put generated files outside the
  vault — the gap fixed for `capture` in 0.6.3, in the two places that fix did
  not reach.
- **A static test fails on any new truncating write** outside the two files
  where one is justified, for the same reason the network check is static as
  well as dynamic: a path no test exercises is exactly where the next one goes.

## 0.7.9 — 2026-08-08

- **"No network calls" is now enforced, not just stated.** The README leads
  with it, and for a tool pointed at a private vault that is a promise about
  the vault. It holds — trapping `fetch` and running the whole pipeline (index,
  searches, assert, query, aggregate, capture, mark-used, reindex, dream with
  `--apply`, graph export) produces zero calls, with the default embedding
  provider `none`.

  Guarded two ways, because either alone is weak: a runtime check only covers
  paths a test exercises, so a static check greps every source file for `fetch`
  or a node network module and allows exactly one — the opt-in embedding
  client. Verified to fail: a stray `fetch` added to `capture.ts` names the file
  and fails the suite.

This is the kind of promise that erodes one reasonable-sounding convenience at
a time — a version check, an update notice, a crash report — each defensible
alone. Cheaper to make it fail loudly than to rely on remembering.

## 0.7.8 — 2026-08-08

- **`lore graph export` now contains the links between notes.** It emitted
  notes, entities and note→entity mention edges — and no note→note edges at
  all, so a vault's explicit `[[wiki links]]`, the structure this project
  treats as its highest-precision signal, appeared nowhere in the file. Opening
  the export in a graph tool showed a vault with no connections unless two
  notes happened to share an entity. Link edges are resolved through the same
  function retrieval uses, so an ambiguous name points at the same note in the
  picture as in the search.
- **The export says what it left out.** Entities used only once are dropped —
  reasonable for a picture, a leaf adds clutter without adding a path — but
  3 entity nodes out of 13 reads as the whole vault. The dump now carries a
  `meta` block with the real counts.

Also checked and sound: fact lines round-trip exactly. 600 generated fields
built from the characters that carry meaning in the format — `::`, braces,
commas, backslashes, newlines, emoji — all survive being written and read back.
That property is now a test, and it was verified to fail when the `::` escape
is removed.

## 0.7.7 — 2026-08-08

- **`dream` no longer calls a linked note an orphan.** It carried two more
  copies of the one-path-per-name resolution fixed in 0.7.6, so with two
  projects each holding an `overview.md` both `[[Overview]]` links were
  credited to whichever note was enumerated last and the other was reported as
  `orphan? projects/atlas/overview.md` — about a note its own project's plan
  links to. Stated as a finding rather than shown as a ranking, so a reader
  would act on it.
- **A name with several owners is checked by membership.** dream asks whether
  an entity name belongs to one of two notes, to avoid suggesting a link on the
  evidence of a note's own name. Picking a single owner let the other note pass
  that check and be linked to itself by name.

Four copies of one rule, in four files, each subtly different — that was the
defect; the orphan report was a symptom. It lives in one exported function now.

## 0.7.6 — 2026-08-08

- **An ambiguous link no longer resolves to the wrong project's note.** The
  name index held one path per name, so two notes titled "Overview" — or two
  projects each with an `overview.md` — meant the last one enumerated won and
  every link to that name pointed at it. A `[[Overview]]` written inside
  `projects/atlas/` could resolve to `projects/northwind/`, silently, and a
  search for something only Atlas says would surface Northwind's notes through
  the borrowed edge. Per-topic folders each holding a README or an overview is
  the normal way people organise a vault.

  Ambiguous names now resolve to the nearest note by shared directory prefix —
  what a link written inside a folder means by any reading. Unambiguous names
  are untouched; ties fall back to sorted order so the graph is stable.
- **Backlink credit follows the same rule.** `updateImportance` resolved names
  with its own copy of the one-per-name map, so one note collected the other's
  backlinks and the in-degree boost landed on the wrong project. Both now use
  one resolver.

Not fixed, and visible on purpose: the entity graph still has a single
`overview` key for both notes, so PPR can cross between them. On the same
vault the affected notes now rank *below* the correct ones rather than
displacing them — the high-precision channel is right and the noisy one is
merely noisy. Per-note identity for title entities is a larger change than this
finding justifies.

## 0.7.5 — 2026-08-08

- **A note with two identical sections no longer loses its usage history.**
  Usage is preserved across a reindex by matching block *content*, which is why
  renaming a heading keeps it and editing a body resets it — both correct. But
  hash alone is not an identity: a note can hold the same text twice (a
  repeated disclaimer, a duplicated table row, the same instruction under two
  headings), and the restore map was keyed by hash, so the two collapsed, the
  last one won, and **both** blocks came back with its state. A reindex that
  changed nothing wiped all learned state for that note — and usage is the one
  thing in the index that cannot be re-derived from the vault, so it was simply
  gone.

  Matching is now anchor-first with content as the fallback, preserving every
  existing behaviour: unchanged blocks keep their history, a renamed heading
  carries it across, an edited body resets it, and identical blocks keep their
  own.

Also checked and found sound: block anchors are heading paths, so inserting a
section, reordering sections and editing a body all leave every other anchor
intact.

## 0.7.4 — 2026-08-08

The last load-bearing claim to get generated histories instead of hand-picked
ones: the vault is the source of truth, so deleting the index and replaying the
journal must reproduce the same facts. One hand-written example passed;
**68 of 120 generated histories did not.** Four causes:

- **`user_valid_until` lived only in the database.** Added two releases ago, it
  was written but never read back from the journal, so an explicit
  `--valid-until` was lost on rebuild — a fact that survives only if you never
  delete the cache, which is precisely what this claim forbids.
- **Replay's dedupe key ignored `valid_until`,** collapsing "final from June
  until January" and "final from June" into whichever came first.
- **The live path had no dedupe,** so two identical assertions became two rows
  and the chain closed the first at its own start — a zero-length fact — while
  replay collapsed them. Both paths now share one identity: slot, value,
  validity window; deliberately not `recorded_at`, since logging the same claim
  twice is one fact stated twice.
- **`invalidate` found different rows in each path.** Live recomputes after
  every assert, so superseded facts are already closed and it correctly finds
  nothing open; replay batched its inserts and saw rows open only because the
  recompute had not run.

Zero of 200 now, and the histories are a test.

## 0.7.3 — 2026-08-08

The other central claim — incremental indexing equals a rebuild — rested on
nine mutations chosen by hand, which is the same kind of evidence that let the
fact store's invariants pass three examples while failing 127 of 300 generated
ones.

- **Checked against 150 generated mutation sequences** — random adds, edits,
  deletes, moves and truncations across nested directories, reindexing after
  each step, comparing every table against a rebuild of the same bytes.
  **Zero failures.** Sixty of them are now a test.

That is a weaker result than the last release and worth saying so: it found
nothing. The reason to trust it is that the check was checked — disabling
orphan-entity pruning made 20 of 20 sequences diverge, and restoring it took
them to zero. Without that step, a clean run means only that the probe ran.

## 0.7.2 — 2026-08-08

Yesterday's supersession fix was verified with three histories written by hand.
Generating three hundred instead, **127 violated the one-value-per-slot rule** —
and the failing histories are not exotic. Asserting facts out of valid-time
order, or invalidating and then asserting again, left a slot with two values
valid at the same instant, silently and permanently. The hand-written examples
all happened to assert in chronological order, which is the case that works.

Both causes predate that change (verified against the previous release).

- **A stale close date could never be corrected.** `recomputeSupersessions`
  rebuilds the chain from scratch but closed with `COALESCE(valid_until, ?)`,
  so any date already present survived every recompute. Clearing it wholesale
  would have discarded `invalidate` and explicit `--valid-until`, so the two
  are now separate columns (schema v6): the recompute owns the computed close
  and reads the user's.
- **`invalidate` before a fact began is refused.** It produced intervals like
  `(2025-06-01 → 2025-01-01)`. That is a typo, not a fact.
- **A user's close is an upper bound, not an override.** "Not true after D" and
  a later value's "not true after D2" are the same kind of claim; the binding
  one is whichever comes first. Letting the explicit close win outright left a
  closed fact overlapping its own successor.

Zero failures across all three hundred histories, which are now a test.

## 0.7.1 — 2026-08-08

- **Re-confirming a value no longer leaves the slot with two current answers.**

  ```
  $ lore facts --subject Ledger
  Ledger :: status :: final  (2026-08-01 → now)
  Ledger :: status :: draft  (2026-01-01 → now)
  ```

  Supersession compared each record only with its immediate neighbour, and a
  same-value successor was linked `extends` and left **open**. With
  draft(Jan), draft(Mar), final(Aug): Aug closed Mar, and nothing ever closed
  Jan, because Aug was not its neighbour. Re-confirming a value is ordinary,
  and doing it once broke the slot permanently and silently — one current value
  per slot is the invariant the fact store rests on.

  Every record is now closed by the one after it; only the link type says
  whether the value changed. Nothing is lost: the value is continuous across
  both records, so point-in-time queries land on whichever covers the date.

  The report stays honest separately — re-asserting a value still says nothing
  was superseded, because telling you `superseded: "draft"` when you just wrote
  "draft" describes a change that did not happen.

## 0.7.0 — 2026-08-08

- **The record-time axis is queryable: `--as-known-at` / `asKnownAt`.**
  `recorded_at` and `superseded_at` were written on every fact, returned in
  every result, used for supersession bookkeeping — and impossible to query.
  Half the bitemporal model was write-only, in the feature the README leads
  with.

  `asOf` alone rewrites the past whenever something is backdated:

  ```
  $ lore facts --subject Vendor --as-of 2024-06-01
  Vendor :: reliability :: poor — outage postmortem

  $ lore facts --subject Vendor --as-known-at 2024-06-01
  Vendor :: reliability :: good
  ```

  Both are correct answers to different questions. The first is what we now
  believe was true in June 2024; the second is what anyone deciding something
  in June 2024 actually had. A postmortem written afterwards makes the first
  useless for explaining that decision — which is exactly the case a store with
  only history cannot express.

  *Known at T* means recorded by then and not yet superseded by then: a fact
  asserted afterwards was not available to anyone reasoning at T, however early
  its validity was backdated. The two axes combine for "what was true then, as
  far as we knew then".

Verified first that valid-time travel was already correct on a vault with real
history — the role held in 2025, nothing before any fact was valid, and the full
chain under `--history`.

## 0.6.9 — 2026-08-08

Ran `dream` against a vault with real fact history — on the vault audited
earlier it reported three of five detectors as "n/a, no input yet", so
contradictions and staleness had never produced output at all. Contested facts
work well (two owners both effective the same day came back as "needs a human
ruling"), and staleness correctly declined to flag a backdated but freshly
recorded fact.

- **A change is dated when it happened, not when it was written down.**
  Supersessions read `"Senior Engineer" → "Staff Engineer" (2026-08-08)` for a
  change effective June 2025 — the timestamp was the day it was typed. The
  detector selects by record time, which is right (the list answers "what did
  we learn recently"), but described the finding with the same timestamp, and
  those differ whenever a fact is backdated — which is most of the time.
  Importing a year of history in one sitting reported every change in it as
  today's. Now: `effective 2025-06-01, recorded 2026-08-08`, collapsing to one
  date when they agree.

This is the distinction the fact store exists to keep, and the staleness
detector already respected it one function away.

## 0.6.8 — 2026-08-08

- **`ask` no longer prints the same facts twice.** Tested on a vault that
  actually has facts — every vault it had been tried on was factless, so half
  of "top passages + current facts" had never been exercised. The facts section
  works; underneath it, the top passage was the journal line recording those
  same facts, in the syntax the engine writes for itself, and the line it chose
  was about a different predicate than the question asked. This grows with use:
  every assert appends another line to a journal that is indexed on purpose.

  `ask` now drops passages that are nothing but fact records, and only when the
  facts are being shown anyway. `search` is untouched — searching for a record
  should find the record — with a test for each half.
- **`- [fact]` lines count as machine text when quoting part of a block,** the
  same rule already applied to fenced source.

## 0.6.7 — 2026-08-08

- **Search no longer slows down the longer a vault is used.** Every edit
  deletes and reinserts a note's blocks, and FTS5 writes a new segment each
  time rather than updating in place. Nothing merged them. On a 200-note vault,
  twenty rounds of editing took 300 searches from 103 ms to 126 ms; merging
  brought it to 94 ms — below the original, since merged segments are denser
  than the ones a first index leaves behind. On a 300-note vault the same
  experiment gave 133 ms → 113 ms. The magnitude depends on the write pattern
  (FTS5 merges on its own under some conditions); the direction does not.

  Merging runs in `dream`, where maintenance with no effect on results belongs.
  It costs 1 ms on 200 notes and 8 ms on 2 000 — cheap enough to need no
  schedule — and a failed merge can never fail a consolidation report.

Measured and deliberately not acted on: the database file grows ~60% under
repeated rewriting of identical content, and `VACUUM` recovers only a third of
that. The rest is real index structure rather than free pages, so vacuuming
would mostly buy a long pause.

## 0.6.6 — 2026-08-08

- **Retrieval history is bounded.** `access_log` was written on every search —
  five rows, one per result, each carrying the full query text — and read in
  exactly one place, as a `COUNT` for dream's stats. Nothing pruned it: an
  agent searching 200 times a day accumulates ~365 000 rows a year.

  Size is the smaller half. Everything else in the index is derivable from the
  markdown, which is what makes "delete `.lore` and reindex" a real answer.
  This table was the exception — the user's complete search history, in
  plaintext, accumulating indefinitely in a file described as a rebuildable
  cache, shown by no command and cleared by nothing.

  Bounded rather than removed, since the count is a genuine activity signal and
  a recent window is the useful part. Default 5 000 rows; `accessLogRows: 0`
  keeps none. Trimming runs on a margin rather than every insert, so the count
  settles near the cap rather than exactly on it.

## 0.6.5 — 2026-08-08

No defects found this pass. One subtle deliberate choice is now guarded.

- **A never-read block is not treated as forgotten.** Search substitutes a
  neutral `0.5` when a block has no access history, rather than the model's
  literal answer of `R = 0`. Applied literally, the retrievability boost is
  multiplied by zero for every note the user has not already read — exactly the
  material a search is usually for. Nothing pinned this: replacing it with a
  plain `retrievability(days, stability)` reads as a simplification, passes
  every other test, and quietly buries new content.

Also examined and deliberately left alone: the per-note block swap leaves
`lexicalScore` and `parts` describing the ranked block while `anchor`,
`snippet` and `coverage` describe the shown one. That is coherent rather than
inconsistent — `score` and `parts` explain why the *note* ranked where it did,
and `importance` is computed per note so it cannot differ between a note's
blocks anyway.

## 0.6.4 — 2026-08-08

Threw nineteen hostile and malformed queries at search — unbalanced quotes, FTS
operators, `NEAR` syntax, a SQL fragment, a lone surrogate, an RTL override,
50 000 characters without a space. None threw. Every SQL string built by
interpolation turned out to be a zod enum, a generated placeholder list, or a
constant.

- **A query of only function words no longer reports high relevance.**
  `contentTerms` falls back to the raw tokens when a query is nothing but
  function words, so a search never silently returns nothing — a sound rule.
  What it then reported was not: "the of and a an" gave a note coverage `0.8`,
  which the MCP layer renders as `"80% of query terms"`. True, uninformative,
  and read by an agent as strong relevance. Coverage is now `0` for such
  queries and the label reads `"weak — query had no distinctive words"`. The
  results still come back; only the claim about them changed.

A query that merely *contains* function words is untouched — "what is the
riverbed protocol" scores exactly what "riverbed protocol" scores, pinned by a
test, since the sloppy version of this fix would suppress both.

## 0.6.3 — 2026-08-08

- **`capture` can no longer write outside the vault through a symlink.** The
  containment check was lexical: `resolve` normalises `..` but does not follow
  symlinks, so `../secret.md` was refused while `linked/secret.md` — through a
  symlinked folder — went straight through. Measured on a temp vault,
  `lore_read_note` returned a file outside the vault and `lore_capture`
  appended to one and reported success. Both are MCP tools an agent drives.
- **Reads and writes get different answers, deliberately.** `scanVault` follows
  symlinked folders on purpose (one used to be silently invisible), so those
  notes are indexed and returned by search — refusing to read them would leave
  search returning results that cannot be opened. Writes are held to the real
  vault root with symlinks resolved, checked against the deepest existing
  ancestor since `capture` creates its target.

The asymmetry is the point: refusing both would look strictly more secure and
would make every note under a symlinked folder unopenable.

## 0.6.2 — 2026-08-08

- **The benchmark now measures what each retrieval channel is worth.** It has
  always shown that hybrid beats BM25 and never shown which *part* of hybrid
  earned it, so a channel could contribute nothing and the headline number
  would be unchanged. Running the shipped pipeline with each recall channel
  switched off:

  | corpus | entity-PPR | link expansion |
  |---|---|---|
  | kestrel | **+13 pts** reach | +0 pts |
  | northwind | +8 pts | **+25 pts** |

  Both earn their place, and on *different* corpora — each is worth nearly
  nothing on the other's. A single-corpus benchmark would have condemned one of
  them, which is the clearest argument yet for the second corpus existing.
  Deliberately outside the regression gate: improving the graph channel should
  make `hybrid−graph` fall, and that is progress.
- **`weights.graph` and `weights.expansion` say what they are.** Both recall
  channels are read as on/off — they add notes nothing else found and are
  spliced in by position, never competing on score — but `graph` defaulted to
  `0.35` and described itself as "weighted below lexical". Setting `0.7`
  expecting more graph influence changed nothing whatsoever. Default is now
  `1`, with a test pinning that any positive value behaves identically.

## 0.6.1 — 2026-08-08

- **A long query no longer loses everything after its 32nd word.** The FTS
  expression was capped at 32 terms and truncated with no signal, so a note
  containing the one word that mattered was not returned at all — not ranked
  low, absent. That is the shape of query an agent produces: paste context, put
  the ask at the end. Measured on a 400-note vault, 512 OR-terms cost 4 ms, so
  the cap was about an order of magnitude below anything the engine minds; it
  is now 256, a guard against pathological input rather than a tuning knob.
- **Query terms are deduplicated,** as the coverage path already did. Prose
  repeats constantly — "the compaction strategy for compaction of the streaming
  compaction pipeline" is seven terms and four distinct ones — so under any cap
  duplicates spend budget on nothing.

## 0.6.0 — 2026-08-07

- **A long list of `- [fact]` lines no longer loses all but one of them.** An
  oversized paragraph was split by rejoining its words with spaces. Markdown is
  line-structured and several consumers read it that way — `- [fact]` lines,
  Dataview fields, list items — so crossing 350 words in one paragraph merged
  every line into one. A note with 60 fact lines parsed **one** fact, whose
  object was the remainder of the list; the same note with 20 lines parsed all
  20. Nothing failed and nothing warned. Paragraphs now split at line
  boundaries, falling back to mid-line only for a single line that is itself
  over budget. 300 fact lines parse as 300 facts.
- **`aggregateFacts` reports how many groups exist.** It has always returned at
  most 100 and said nothing, so "the computable layer" answered a question
  about 150 distinct values with 100 rows that looked like the answer. It now
  returns `{ groups, totalGroups, limit }` and accepts a `limit` — a breaking
  change to that function's return shape, taken deliberately: an opt-in total
  would have been the same design that produced the bug.

`lore_dream_report` was checked in the same sweep and was already correct — it
carries its totals and a `verbose` escape hatch.

## 0.5.6 — 2026-08-07

- **`lore_context_pack` says when it is showing a sample.** Every list in it is
  capped and none of them said so: with 120 open facts it returned 30, next to
  a `stats` block reporting `openFacts: 120`, with nothing connecting the two.
  For this consumer that is the worst shape — an agent asked "what do we know
  about X" reads `currentFacts`, does not find X, and answers that there is no
  record. A truncation that reads as completeness is indistinguishable from an
  answer, so there is nothing to notice and nothing to retry. The pack now
  reports `{ shown, of, rest }` naming the tool that returns the remainder, and
  omits the field entirely when nothing was cut.
- **`capture` verified under concurrency.** Forty separate processes appending
  at once produce forty well-formed lines — none interleaved, none lost — and
  unicode, emoji and multi-line input all survive. Captured notes are findable
  after the next index.

## 0.5.5 — 2026-08-07

Verified the spaced-repetition layer end to end rather than inferring it from
the FSRS unit tests. Nothing needed fixing; the properties are now asserted.

- **Reinforcement changes what search returns.** With five notes that answer a
  query equally well, marking the last one used moves it to first.
- **Usage history survives a reindex.** It is the only thing in the index that
  cannot be re-derived from the vault, and the index is rebuilt from markdown
  constantly — had a reindex wiped it, the layer would reset every time a file
  was saved and every existing test would still have passed, because they
  exercise the maths in isolation.
- **An edit resets only what it changed.** Rewriting one section of a note
  preserves the history of the sections that did not change and resets that
  one, which is correct: a retrieval history describes text, and that block's
  text no longer exists.

## 0.5.4 — 2026-08-07

- **A mistyped config key is named instead of ignored.** Zod strips unknown
  keys rather than rejecting them, so a wrong key was accepted in silence and
  had no effect: `{"nlpp": false}` left NLP running, and
  `{"index": {"nlp": false}}` — a natural guess, since `nlp` lives at the top
  level — was discarded whole. Config is the worst place for a silent no-op:
  every other surface at least does something you can observe, while editing
  config and re-running produces identical output whether the edit took effect
  or not. Reported as a warning, not an error, so a config written for a newer
  version does not brick an older one.
- **`lore init`'s own config is checked against the schema.** That file is the
  first config most users see; if it drifted it would configure nothing, and
  nothing would say so.

The set of known keys is derived from a fully-defaulted parse rather than from
the schema's internals, so it stays correct on its own as the schema grows.

## 0.5.3 — 2026-08-07

Killed the indexer mid-run on a 1 200-note vault, with SIGTERM and then
SIGKILL. Recovery is already sound — the next index notices the previous one
did not finish, rebuilds, and search comes back correct, with database
integrity ok after a hard kill. The reporting was not.

- **`doctor` no longer reports a healthy vault as broken.** On a half-built
  index it said `broken links: 1091` for a vault whose links are all fine — the
  notes they point at simply had not been indexed yet. Specific, alarming and
  confidently inverted, at the exact moment a user is already worried because
  they just interrupted something.
- **The indexer already knew.** It keeps a marker naming the indexing PID and
  distinguishes a crashed run from a live one, but only the indexer read it.
  That state is exported now, and both commands that read the index as though
  it described the vault — `doctor` and `stats` — say so first.

Tested three ways: an interrupted index is recognised, a live one is not
mistaken for a dead one, and recovery reproduces exactly the blocks and links a
clean index would have produced — "it rebuilds" only reassures if what it
rebuilds is right.

## 0.5.2 — 2026-08-07

Yesterday's migration was nearly wrong in a way that only appears on an
upgrade, never on a fresh install — so the upgrade path got checked properly
rather than the one hop that happened to get tested.

- **Verified against real installs.** 0.1.0, 0.2.0, 0.3.0, 0.3.5 and 0.4.0 were
  installed from npm, each indexed a vault, and the current build then opened
  the same database. All five upgrade cleanly — schema v1, v3 and v4 all reach
  v5, reparse, and still answer searches. Nothing was broken; that is worth
  knowing rather than assuming, because a failed migration does not degrade the
  tool, it stops it starting.
- **Reproduced in the suite without the network.** Each historical schema is
  now built from the migration list itself, so every future migration is
  checked against every old database automatically, rather than against
  whichever version someone remembers to install.
- **The specific mistake is pinned.** Incremental indexing short-circuits on
  mtime *and* size before it consults the hash, so a migration that clears only
  the hash changes nothing. The test fails if that invalidation is weakened.

## 0.5.1 — 2026-08-07

Checked the temporal query path against a vault where every mtime was touched
to now, so file times carried no information at all. Content time held up:
`--since`/`--until` filter on dates from the filename, the frontmatter and the
prose; frontmatter wins when a filename and frontmatter date disagree; mtime is
used only where the content carries no date of its own. `doctor` finds every
broken link and all three graph export formats are well formed.

- **`doctor` quotes each broken link the way the file spells it.** It printed
  `alpha.md → [[sub/nope.md]]` for a line that reads
  `[a broken one](sub/nope.md)`. The parser has always distinguished wiki from
  markdown links and the store discarded it, so the report guessed wiki for
  everything — sending the reader grepping for text that is not in their vault,
  in the one report whose purpose is "go fix this line". Link style is now
  persisted (schema v5).
- **The migration invalidates what the old parser recorded.** Adding the column
  was not enough: incremental indexing short-circuits on mtime *and* size
  before it ever consults the hash, so clearing the hash alone changed nothing
  and every upgraded vault would have kept the column default forever. All
  three keys are cleared, so the next index reparses.

## 0.5.0 — 2026-08-07

Built a vault of the shape someone would actually keep — dated daily notes, a
project whose status and owner change over time — and read what the fact store
made of it. The bitemporal core is sound: the canonical
`- [fact] S :: p :: o {valid_from=…}` round-trips exactly. Three things around
it did not.

- **Frontmatter dates keep the date that was written.** `started: 2025-03-01`
  came back as the object `2025-03-01T00:00:00.000Z` — YAML parses a bare date
  into a Date, and frontmatter is stored as JSON, so every reader saw an
  instant with a timezone nobody typed. A guard for exactly this existed in the
  extractor and was dead: it tested `instanceof Date` on a value JSON had
  already turned into a string. Frontmatter is normalised at parse time now; a
  value with a real time of day keeps it.
- **Trailing `{valid_from=…}` is honoured on every fact form.** It is this
  project's own syntax — the journal emits it on every line it writes — but
  only `- [fact]` read it back. Elsewhere the braces were swallowed into the
  object, so the date was lost *and* it corrupted the value. A `{...}` that is
  not `key=value` is left alone.
- **Dataview fields are read on a bare line, not only inside a list.** Obsidian
  users write `key:: value` on its own line at least as often, so half of a
  supported convention was silently ignored. The space after `::` is what makes
  this safe — `std::vector`, `Foo::bar` and every scope operator in every
  language have none — and fenced blocks are skipped regardless.

## 0.4.10 — 2026-08-07

0.4.9 removed heading echoes from duplicate detection. Rather than wait to trip
over the same object again, every consumer of block text was checked against
it — and embeddings had the same bug, worse.

- **Heading echoes are no longer embedded.** Identical text yields an identical
  vector under any model, so two notes sharing a section name — "Overview",
  "Usage", "The Process" — scored a cosine of exactly 1.0 and got a
  maximum-strength `SIMILAR` edge between them. That edge feeds graph
  expansion, so what showed up as a wrong line in a report was also silently
  steering retrieval, where nothing would have surfaced it. They also cost real
  embedding calls on text nobody wrote: 40 of 501 blocks on the test vault.
- **One shared definition.** `isHeadingEcho` is now exported and used by both
  `dream` and the embedder. Two copies would drift, and both failures it
  prevents are silent.

Nothing is lost: an echo exists so a headings-only note stays findable, and its
heading is already in the lexical index. The test asserts both directions — no
similarity edge from a shared section name, and both notes still returned when
searching for that heading.

## 0.4.9 — 2026-08-07

Ran `dream` over a real docs vault and read what it found. Link suggestions are
real — `code-reviewer.md` and `task-reviewer-prompt.md` share eighteen
entities. The duplicates were not.

- **Two sections with the same name are no longer "duplicates".** Top of the
  list was `"The Process" ≈ "The Process"` at Jaccard 1.0 for two unrelated
  skills. Since 0.4.1 a section with no body of its own is indexed as an echo
  of its heading, so a headings-only note stays findable — but section names
  repeat constantly, so comparing those echoes as content made every shared
  section name an identical passage. 40 of 501 blocks in that vault were
  echoes, and they produced most of the duplicate findings. The echo stays
  indexed and searchable; it is excluded from duplicate detection only.
  Genuinely copy-pasted prose is still caught, and both halves are now tested.
- **Every finding type shows examples.** `dream` reported "6 duplicates · 23
  orphans" and then listed only link suggestions; the rest were visible only by
  running `--apply`, which writes files into the vault — so looking required
  changing. Duplicates, stale items and orphans now each show a few, with a
  count of how many more.

## 0.4.8 — 2026-08-07

Read `ask` output on a real docs vault and followed one odd line: the answer to
"when should I use a worktree" included a note about persuasion technique,
reached "via use".

- **A shouted word is emphasis, not an acronym.** `use` was an entity because
  of "YOU MUST USE IT" — the acronym exemption fired on any all-caps token,
  and that exemption exists precisely to rescue `NASA` and `API` *from* the
  common-word filter, so unconditionally it resurrected the very words the
  filter removes. Documentation shouts constantly, so this was a standing
  mis-read of emphasis as vocabulary. `NASA` and `API` are unaffected.
- **A contraction is not a person.** "I'm" tokenises to a capitalised `Im` and
  tags PROPN, making it an entity in 9 of 39 notes in a vault whose every skill
  opens by announcing itself. `O'Brien` and `D'Angelo` are untouched.
- **Seed mass is scaled by inverse document frequency.** An entity mentioned
  across a quarter of the vault is background, not a topic; spreading
  activation from it reaches a quarter of the vault, which is the same as
  reaching nothing. This is the general form of a stopword list, and unlike one
  it needs no maintenance and adapts to whatever the vault is about.

IDF alone would not have fixed `use` — it appears in two notes, so it is rare,
just meaningless. Rare-and-meaningless needs the extractor;
common-and-meaningless needs the weighting.

Top entities on that vault are now TDD, Task, Review, API, Subagents, Gemini
CLI, Copilot CLI, YAGNI. Both eval corpora unchanged.

## 0.4.7 — 2026-08-07

Verified against the published package: the MCP wiring the README documents
works end to end over real stdio, and so does an MCP server running live under
an agent while the user works in a terminal — the CLI indexes, the server sees
the new note immediately, both write facts at once, nothing is lost.

- **A mistyped `--vault` says so.** It reported
  `ENOENT: no such file or directory, mkdir '/nope/.lore'` — a raw errno naming
  an internal directory the user has never heard of, for a mistake in the one
  argument they can see. Now: `vault not found: /nope`, and
  `vault is not a directory` when the path is a file.
- **Auto-indexing is opt-in** (regression from 0.4.6, where it was opt-out). It
  fired for commands that never read the note index, so a mistyped date spent a
  full pass over the vault before reporting the typo. It is now held to the
  commands that answer questions about note content — `search`, `ask`, `dream`,
  `graph`, `mark-used`.

## 0.4.6 — 2026-08-07

Installed the published package into a clean directory and used it as a new
user would. The first command typed said the wrong thing.

- **A never-indexed vault no longer answers "no results".** `lore search` in a
  vault of 39 notes replied `no results`; `ask` replied `nothing found`. That
  is indistinguishable from a genuine miss, delivered at the one moment a new
  user cannot tell the difference — it says the tool works and their notes are
  empty. Only `doctor` told the truth. An empty index is now filled on the
  spot, once, by any command that answers questions about the vault.
- **Agents were affected worse than people.** Over MCP there was no error to
  react to — just `[]`, which an agent reports as "you have nothing written on
  this". The server now indexes before serving its first request.
- **The commands that report on the index itself opt out.** `index`, `doctor`
  and `stats` still show the true state, including that it is empty — as does a
  genuinely empty vault, where "no results" is the correct answer.

## 0.4.5 — 2026-08-07

Indexed a real 86-note documentation vault instead of a synthetic one. The
ranking held up — every probe query returned the right note *and* the right
section — but what got *shown* did not.

- **A generated diagram no longer masquerades as the answer.** Asking "what
  should I do when a test fails" returned the correct heading of a TDD guide
  and then displayed 800 characters of `digraph tdd_cycle { … }`. Generated
  source restates the vocabulary of the prose it illustrates, so it ties on
  term coverage — and ties went to whichever block came first, which is the
  diagram. It now has to out-cover the readable alternative outright, and the
  same query returns *"MANDATORY. Never skip. … Confirm: Test fails (not
  errors), failure message is expected"*.
- **Previews lead with prose.** A snippet that runs from prose into its example
  reads well; the same two pieces in the other order bury the answer behind
  source the reader has to scroll past. Context now grows forward into code but
  never backward into it.
- **Bare fence markers are gone from previews** — a snippet no longer spends
  its first characters rendering ``` for a renderer that is not running.

Across 36 real hits, previews opening with raw source went from 6-in-30 to
1-in-36 — and the survivor is a query about the diagram itself.

## 0.4.4 — 2026-08-07

- **`watch` now reindexes a vault that never goes quiet.** The debounce
  restarted its timer on every change, so as long as changes kept arriving no
  reindex ever ran — and the things that keep a vault busy are exactly the ones
  that matter: a sync client landing another device's notes, a bulk import,
  `git checkout` of a large branch, an agent capturing as it works. Measured:
  six seconds of writes 120 ms apart produced **zero** reindexes, so every
  search in that window answered from a stale index with nothing to say so.
  A reindex is now deferred at most `maxWaitMs` (default 2 s), while a single
  edit still waits out the full quiet period.
- **`watch` has tests at all now,** including the three ways real editors save:
  in place (Obsidian), temp-file-and-rename (VSCode, Emacs), and
  backup-then-write (vim). All three already worked; nothing was checking.
- **Incremental indexing is asserted equal to a rebuild.** After each of nine
  vault mutations — edit, delete, rename, move, add, truncate, drop a folder,
  swap two notes, replace everything — the incrementally-updated database must
  match a from-scratch index of the same bytes, down to blocks, links,
  entities, mentions and FTS rows. The index is meant to be disposable; this is
  what makes that claim checkable.

## 0.4.3 — 2026-08-07

- **A pasted blob no longer holds a vault hostage.** Indexing a note containing
  one very long unbroken token — an Excalidraw drawing, a base64 `data:` image,
  a minified bundle, a JWT — took time *quadratic* in that token's length,
  because the POS tagger is. A 2 MB blob took roughly half an hour for that one
  note; it now takes 38 ms. A 3 000-note, 19 MB vault that previously did not
  finish indexing in ten minutes now indexes in 4 seconds.
- **Blocks are capped in characters, not only in words.** The existing word cap
  was measured in the wrong unit for the exact case it was written for: a blob
  is ONE word, so `words <= 350` passed and the block stayed unbounded. Blocks
  are now also capped at 4 000 characters, which additionally bounds CJK
  paragraphs — they contain no whitespace either.
- **Splitting never severs a surrogate pair,** so emoji and astral-plane text
  cannot be corrupted on the way into the database.
- Tokens of 64 characters or more are no longer fed to the entity tagger. No
  proper noun is that long; the things that are — hashes, payloads, data URIs —
  were only ever noise in the graph.

## 0.4.2 — 2026-08-07

- **Frontmatter-only and empty notes are findable.** A note whose entire
  content is frontmatter — a metadata record, a template stub — produced no
  blocks and could not be found by its own title. Its title and scalar
  frontmatter values are now indexed, so both `Marmoset` and `active` find
  `title: Marmoset Index / status: active`. An empty file is likewise findable
  by its filename, which is the same stub workflow.
- **A sweep of note shapes is now a permanent test.** Twelve shapes — code
  block, table, list, frontmatter, heading, MOC, image, single word, CRLF, BOM,
  no trailing newline, blockquote — must each be findable by a word they
  contain, and every note must produce at least one block. This failure mode is
  silent: the note indexes without error, `stats` counts it, and every search
  returns nothing.

## 0.4.1 — 2026-08-07

- **Notes that are only headings are searchable.** A note containing just
  `# Quokka Protocol` produced zero blocks and could not be found by searching
  for its own title. Stub notes — the kind created by following a link before
  writing anything — and index/MOC notes built from headings were entirely
  invisible, while the note count reported them as indexed. A heading with no
  body is now treated as its own content. Measured on a 3-note vault: 1 block
  became 5, and both previously-unfindable notes are found.

## 0.4.0 — 2026-08-07

### CJK vaults now work

Chinese, Japanese and Korean text is written without spaces, so the full-text
tokenizer treated an entire sentence as a single token: a vault of Chinese
notes indexed fine and then returned **nothing** for any query. Searching
`机器学习` against a note containing `这个项目关于机器学习` matched zero rows.

Text handed to the index is now segmented per CJK character, and queries are
segmented the same way, so a query becomes a phrase of character tokens. This
is the standard fallback where a language-specific segmenter is unavailable.

Verified across scripts, with English unchanged:

| script | before | after |
|---|---|---|
| Chinese `机器学习` | no results | found |
| Japanese `機械学習` | no results | found |
| Devanagari `मशीन लर्निंग` | worked | worked |
| accented Latin `stockage durable` | worked | worked |
| English | worked | worked |

Schema v4 adds the exact text given to the index as a stored column, since
per-character segmentation cannot be expressed in the trigger's SQL. Existing
indexes migrate automatically; run `lore index --full` to re-segment old
content.

## 0.3.5 — 2026-08-07

- **`dream` stays quiet when it has nothing to say.** On a densely interlinked
  vault — a Zettelkasten of small atomic notes — every pair co-cites a couple
  of neighbours, so thousands of pairs score almost identically and the "top"
  thirty are arbitrary. Suggestions must now stand clearly above the typical
  candidate. Measured across three real vaults: a 3,000-note Zettelkasten went
  from 30 arbitrary suggestions to 0, while a personal vault kept all 30 of its
  good ones and a docs corpus kept its 9.
- **Windows is a tested platform.** CI now runs Linux, macOS and Windows across
  Node 20 and 22. The product itself passed on the first Windows run; the eval
  harness did not, because dynamic import of an absolute path needs a `file://`
  URL there.

## 0.3.4 — 2026-08-07

- **Notes inside symlinked folders are indexed.** A symlink reports as neither
  file nor directory, so a folder linked into a vault was skipped entirely and
  its notes were simply invisible — with nothing in the output to explain why.
  Links are now followed, with a visited-realpath set so a link pointing at an
  ancestor terminates instead of walking an infinite tree. Dangling links are
  skipped rather than fatal; `followSymlinks: false` restores the old
  behaviour.

## 0.3.3 — 2026-08-07

Context economy on the MCP surface, plus a presentation fix.

Agent tool responses are the product's main interface, and every token spent
on score internals is a token not spent on the user's actual task. Measured
against a real 40-note vault:

| tool | before | after |
|---|---|---|
| `lore_search` | ~1,290 tokens | **~735** |
| `lore_context_pack` | ~1,470 tokens | **~1,000** |
| `lore_dream_report` | ~2,640 tokens | **~580** |

- **Search returns what an agent acts on** — the note, the section, the text,
  and how much of the query it matched — instead of five floats at seventeen
  significant digits. `verbose: true` restores the full shape.
- **The dream report returns a summary** with the few findings worth acting
  on; `verbose: true` returns every finding.
- **Horizontal rules no longer leak into snippets.** The markup filter ran
  when choosing and extending, but not at render, so a `---` between the
  chosen window and its context still reached the output.

## 0.3.2 — 2026-08-07

Presentation fixes, all found by running the tool on real documents. Each is a
case where retrieval was already correct and the output made it look wrong —
a class of defect recall metrics score as a success.

- **Snippets find answers split across wrapped lines.** Markdown is almost
  always hard-wrapped, so the sentence answering a query is routinely split in
  two. Scoring lines individually let each half count one term and lose to an
  unrelated earlier line, so a query about the index being a cache showed the
  README's HTML header instead of the sentence saying exactly that. Snippets
  now score windows of consecutive lines.
- **Markup is no longer presented as content.** Tag-only lines are skipped when
  choosing and extending a snippet, and tags are stripped from the rendered
  text: `<h1 align="center">Loreweave</h1>` reads as "Loreweave". The indexed
  text is untouched.
- **Result lines stay readable.** The location line printed the full heading
  breadcrumb, which reached 327 characters on a deeply nested note and buried
  the snippet. It now shows the file and innermost heading; `--json` still
  carries the exact anchor.
- **Link suggestions no longer reward length.** Raw IDF-sum meant two sprawling
  documents about one project always looked related. Scores are normalized by
  note size, so the question is whether two notes share more than their length
  predicts.

## 0.3.1 — 2026-08-07

Fixes found by dogfooding a real documentation corpus.

- **Notes whose filename states a role no longer collapse into one entity.**
  39 separate `SKILL.md` files all resolved to the title "SKILL", so their
  frontmatter facts landed in a single subject and superseded each other
  arbitrarily. A title now prefers frontmatter `title`, then `name`, then the
  filename — except for generic names (`SKILL.md`, `README.md`, `index.md`),
  where the parent folder identifies the note: `skills/writing-skills/SKILL.md`
  is "writing-skills". Measured on that corpus: 1 collapsed subject became 14
  correctly attributed ones.
- **Facts whose object merely repeats their subject are dropped.**
  `writing-skills :: name :: writing-skills` states nothing, and was appearing
  at the top of `lore ask` output.

## 0.3.0 — 2026-08-06

Retrieval, provenance, and durability. Every number below is produced by
`npm run eval` and enforced in CI.

### Retrieval

- **Markdown links are first-class graph edges.** Vaults outside Obsidian use
  `[text](path.md)`, which the engine could not see. On a real vault this took
  links from 1 to 15 and orphans from 39 to 25.
- **Link expansion finds what lexical search cannot reach.** Multi-hop answers
  share no vocabulary with the query; BM25 finds 0% of them at any depth, while
  hybrid now finds 90% (kestrel) and 100% (northwind).
- **Recall mechanisms backfill instead of competing.** Both link expansion and
  entity-PPR displaced confident lexical hits when treated as peer ranking
  lists — measured 0.489 → 0.208 MRR in the worst case. As backfill they add
  reach without costing precision.
- **Natural-language questions work.** Function words were treated as content,
  so AND semantics let one stray "what" exclude the answering block. MRR
  0.495 → 0.538.
- **Snippets show the line that answers the query**, not wherever FTS5 pointed
  — a correct result that displays the wrong excerpt reads as a miss.
- **Content time, not file time.** `--since`/`--until` filter on frontmatter
  dates, dated filenames, and dates in the text; mtime is only the fallback.

Measured against two independent corpora (the second built specifically to
detect overfitting — different link syntax, note shapes, and vocabulary):

| corpus | hybrid reach | BM25 reach | hybrid MRR | BM25 MRR |
|---|---|---|---|---|
| kestrel | 98% | 75% | 0.540 | 0.532 |
| northwind | 96% | 63% | 0.643 | 0.521 |

### Facts

- **Facts are extracted from the conventions vaults already use** —
  frontmatter, `key:: value`, `- [key] value`. The store measured 0 facts on
  every real vault before this. Prose formatting is opt-in
  (`facts.extract: "all"`) or reviewable via the `lore_propose_facts` MCP tool.
- **Provenance is visible.** Every fact prints where it came from and whether
  it was asserted, extracted, or inferred, so a supersession chain reads as an
  audit trail.
- Fixed: `::` in a subject corrupted facts permanently; frontmatter dates were
  silently dropped; task-list items (`- [x] …`) were parsed as facts.

### Durability

- A corrupt index resets itself rather than bricking every command.
- Concurrent commands no longer fail with "database is locked".
- A crash mid-index is detected by PID and repaired on the next run.
- `dream` survives real vaults: 3,200 notes went from 69.6s/3.56GB to
  1.11s/190MB, and 12,800 notes (double the previous OOM point) now works.
- Unbounded inputs are capped — a 1MB single-paragraph note took search from
  30.05s to 0.16s.

### New

- `lore watch` — reindex automatically as the vault changes.
- `npm run eval` — the retrieval benchmark, as a CI gate over both corpora.
- `npm run smoke` — verifies the packed tarball, not just the source.

## 0.2.0 — 2026-08-06

First public release with the full engine: hybrid retrieval, bitemporal facts,
FSRS dynamics, the dream consolidation pass, CLI, and MCP server.

## 0.1.0 — 2026-08-05

Initial release.
