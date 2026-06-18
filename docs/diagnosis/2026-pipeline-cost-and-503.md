# Pipeline Cost & 503 Diagnosis — 2026-06-18

**Written from:** Docker log buffer (1 day retained, 2026-06-17) + `premium_analyses` table (all-time, 115 rows).  
**Limitation:** Cost logs are console-only and not persisted to DB. The Docker log buffer captured only ~18:38 UTC on 2026-06-17 onward. The $10 spend cited in the spec pre-dates this window and cannot be reconstructed from logs alone.

---

## (a) Cost breakdown (retained log window: 2026-06-17), by stage + model

| Stage         | Model              | Calls | Input tokens | Output tokens | Estimated cost |
|---------------|--------------------|------:|-------------:|--------------:|---------------:|
| vision        | gemini-2.5-flash   |     8 |        8,409 |         3,424 |       $0.0110  |
| compose       | gemini-3.5-flash   |     0 |            — |             — |       $0.0000  |
| verify        | gemini-2.5-flash   |     0 |            — |             — |       $0.0000  |
| **TOTAL**     |                    |   **8** |              |               |     **$0.0110** |

**Key finding:** Zero successful compose or verify calls in the retained log window. The composer (gemini-3.5-flash) returned 503 on every attempt starting 2026-06-17T18:38 UTC. Vision calls (gemini-2.5-flash) succeeded.

**Historical cost estimate (from DB row counts, no logs):**  
115 premium analyses ran all-time (June 12–17). Assuming prior periods had successful compose+verify runs:
- Vision: 115 × ~$0.0014 = **~$0.16**
- Compose (input ~1,500 tok, output ~300 tok @ gemini-3.5-flash $0.30/$2.50 per 1M): 115 × ~$0.0012 = **~$0.14**
- Verify (similar to compose): 115 × ~$0.0012 = **~$0.14**
- Total estimated all-time: **~$0.44**

The $10 figure in the spec cannot be reconciled from available data. Hypotheses: (1) logs predate retention window and a larger batch ran; (2) pricing changed between runs; (3) output tokens were much higher than estimated. Section (e) is inconclusive due to 503 storm. A cost logger writing to the DB (rather than console-only) is needed for reliable accounting.

---

## (b) Per-business analyze cost + duplicate count (last 7 days)

**DB query results:**

| Metric | Value |
|--------|------:|
| Total premium_analyses runs (last 7d) | 115 |
| Distinct businesses analyzed (last 7d) | 92 |
| Businesses analyzed >1 time (last 7d) | 10 |
| Avoidable runs (same biz, same 7d window) | 23 |
| Total premium_analyses runs (all time) | 115 |
| DB oldest run | 2026-06-12 |

**Interpretation:** 10 out of 92 businesses (11%) were re-analyzed within the 7-day window. 23 out of 115 runs (20%) were redundant. Since `premium_analyses.completedAt` was never checked for TTL, every time a business appeared in a new batch, a fresh Playwright render + PSI + vision pass was re-run unconditionally.

**Per-business cost (estimated):** ~$0.0038/business (vision + compose + verify) × 23 avoidable runs = **~$0.09 avoidable spend in this window**. Small in absolute terms but scales proportionally with batch size.

**Limitation:** Logs are not tagged by businessId, so per-business cost breakdowns require a future change to the cost logger.

---

## (c) 503 / overload rate per (stage, model) — 2026-06-17 window

| Stage   | Model              | Status  | Classification | Count |
|---------|--------------------|---------|----------------|------:|
| compose | gemini-3.5-flash   | 503     | OVERLOADED     |   202 |
| compose | gemini-3.5-flash   | timeout | TIMEOUT        |    15 |
| vision  | gemini-2.5-flash   | 503     | OVERLOADED     |     2 |
| vision  | gemini-2.5-flash   | (ok)    | SUCCESS        |     8 |

**Success vs failure:**
- compose (gemini-3.5-flash): **0 successes / 217 failures = 100% failure rate**
- vision (gemini-2.5-flash): **8 successes / 2 failures = 80% success rate**

**Classification:** 503 = OVERLOADED (Google service unavailable, not a quota issue). The 15 timeouts on compose are from the per-attempt hard timeout (`GEMINI_TIMEOUT_MS`, default 30s) firing on stalled requests before a 503 response arrived. No 429 (quota) errors observed — the RPD budget was not exhausted.

**Root cause:** gemini-3.5-flash is the configured composer model (`GEMINI_MODEL` default). It has been in a sustained 503 overload state for the entire retained log window. gemini-2.5-flash (used for vision and verify) is stable.

**Retry behavior:** The existing retry loop in `withGeminiRate` retried each compose call up to 5 times (4 retries + initial), honoring RetryInfo backoff. After exhaustion, `callGeminiStructured` retried the outer loop 3 times. Total per-email attempt: up to 15 Gemini calls before giving up — all 503'd.

---

## (d) Cache-hit potential (TTL=14d simulation)

| Metric | Value |
|--------|------:|
| Businesses with >1 done run (all time) | 10 |
| Total extra (avoidable) runs (all time) | 23 |
| Businesses with done analysis >14d old that got rerun in last 7d | 0 |

**Interpretation:** No stale-then-rerun pattern detected (the DB is only 6 days old; no analysis is yet >14 days old). All 23 avoidable runs are same-week duplicates — a business appeared in two different batch runs within a few days.

**Projected savings at TTL=14d:** Had TTL been in place this week, 23 Playwright renders + 23 PSI fetches + 23 vision calls would have been skipped. Estimated cost saving: **~$0.03/week** at current batch sizes. The bigger win is latency — each skipped analysis saves 30–90s of blocking pipeline time per lead.

**Cache-hit potential grows linearly** with: (a) batch size, (b) lead re-use rate (same leads appearing in multiple batches), and (c) any manual re-generate clicks via the /generate route.

---

## (e) Output-token-per-compose distribution

**No data available.** All compose calls in the retained log window returned 503 before producing a response. No compose cost lines were logged.

**Vision output token distribution (proxy, N=8, gemini-2.5-flash):**

| Metric | Tokens |
|--------|-------:|
| n      |      8 |
| median |    436 |
| p90    |    451 |
| max    |    451 |

**Significance:** Vision output tokens are low and stable. Compose output tokens are the primary cost lever (output tokens cost ~8× vision's effective rate when normalized per token — see pricing note below) but cannot be measured until the 503 storm clears.

**Pricing note:** Both models use $0.30/M input + $2.50/M output. Output is 8.3× more expensive per token than input. A 300-token compose response costs more than a 2,000-token compose prompt. Trimming the composer system prompt is lower-priority than fixing the 503s.

---

## Recommendations (ranked by $-impact and urgency)

1. **[URGENT] Composer 503 fallback to gemini-2.5-flash** — Current state: 100% compose failure since Jun 17, zero emails generated. Impact: unblocks all email generation. Risk: minimal — verifier still grades the output. Cost impact: gemini-2.5-flash same pricing tier as gemini-3.5-flash (no cost change). **This is the highest-priority fix in this slice.**

2. **[HIGH] TTL-gated analysis reuse (REUSE_ANALYSIS_TTL_DAYS=14)** — Eliminates 23 avoidable re-runs/week (20% of total). Cost saving is small now (~$0.03/wk) but eliminates unnecessary Playwright load and scales with batch size. Zero correctness risk — data source is unchanged, same types.

3. **[MEDIUM] Add businessId + runId to per-call cost log** — Current log format (`[gemini][cost] label model in=N out=N ~$X`) has no businessId. Cannot reconstruct per-lead cost without it. Change is additive (add field to `console.log` in `recordCost`). Deferred from this slice — out of scope.

4. **[DEFERRED] Composer model swap (gemini-3.5-flash → gemini-2.5-flash as default)** — Would permanently resolve the 503 issue but requires verifier acceptance-rate A/B data to confirm output quality parity. Out of scope for this slice per spec.

5. **[DEFERRED] Output-token trimming on composer system prompt** — Cannot measure impact until compose succeeds. Address in slice 3+ after section (e) data is available.
