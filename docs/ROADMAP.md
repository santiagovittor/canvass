# ROADMAP.md — ranked next slices

Pending work, ranked. Each slice gets a spec under `docs/SLICES/<id>-<name>.md`
when picked up (copy `docs/SLICES/_template.md`). Invariants and the reuse-only
registry live in `docs/SPEC.md`.

Status legend: `planned` · `in-progress` · `done`.

| Rank | ID | Intent | Status | Slice file |
|---|---|---|---|---|
| — | `0001-auto-enrich-analyze-pipeline` | Auto-run enrich + analyze after every scrape — no manual trigger | shipped | [0001](SLICES/0001-auto-enrich-analyze-pipeline.md) |
| — | `0002-text-query-ui-clarity-audit` | Diagnosis of keyword/text-query UI clarity + missing emails | diagnosis done | [0002](SLICES/0002-text-query-ui-clarity-audit.md) |
| 1 | `0003-keyword-run-live-status` | Live SSE stage tracker for keyword runs (no polling) | planned | [0003](SLICES/0003-keyword-run-live-status.md) |
| 2 | `0004-keyword-email-enrichment-gate` | Keyword leads get emails — write the `scrape_jobs` row so the email gate fires | planned | [0004](SLICES/0004-keyword-email-enrichment-gate.md) |
| 3 | `0005-keyword-panel-disclosure-and-provenance` | Demote Bulk/Backlog behind disclosure + email-provenance copy | planned | [0005](SLICES/0005-keyword-panel-disclosure-and-provenance.md) |
| 4 | `0006-scheduler-status-sse` | Replace 15s scheduler-status polling with SSE | planned | [0006](SLICES/0006-scheduler-status-sse.md) |
| 5 | `0007-no-website-lead-outreach` | Contact lane (phone/WhatsApp) + cheap-site offer for no-website leads | planned (needs diagnosis) | [0007](SLICES/0007-no-website-lead-outreach.md) |
| 6 | `0008-daily-operational-digest` | Daily summary of sends / replies / queue health | planned | _(not created)_ |
| 7 | `0009-auto-compose-schedule-high-confidence` | Auto compose + schedule leads above a confidence bar | planned | _(not created)_ |
| 8 | `0010-new-lead-sources-meta-ad-library` | Add Meta Ad Library as a new lead source | planned | _(not created)_ |
| — | `0011-ux-clarity-and-outreach-audit` | Diagnosis: cross-tab run persistence, reply visibility, email validity, open-tracking honesty, type/declutter | diagnosis done | [0011](SLICES/0011-ux-clarity-and-outreach-audit.md) |
| next·1 | `0012-active-runs-persistence` | Server-authoritative active-runs, SSE-rehydrated — runs survive tab switch + show concurrently | planned | [0012](SLICES/0012-active-runs-persistence.md) |
| next·2 | `0013-email-validity-gate-and-bounce-ingestion` | MX + SMTP-RCPT validity gate before compose + bounce/DSN ingestion | planned | [0013](SLICES/0013-email-validity-gate-and-bounce-ingestion.md) |
| next·3 | `0014-reply-visibility-and-reclassification` | Stop hiding auto-classified replies; one-tap reclassify; soften velocity rule | planned | [0014](SLICES/0014-reply-visibility-and-reclassification.md) |
| next·4 | `0015-open-tracking-honesty` | Replace always-on `sin abrir` with honest state; optional spam-safe real tracking | planned | [0015](SLICES/0015-open-tracking-honesty.md) |
| next·5 | `0016-typography-and-outreach-declutter` | Amend DESIGN/ui rules, raise type scale + spacing, collapse Outreach filters | planned | [0016](SLICES/0016-typography-and-outreach-declutter.md) |
| — | `0017-modern-ui-conformance-and-batch-legibility-audit` | Diagnosis: design-rule conformance, batch-runner relocation + legibility/ETA, Gemini quota visibility, Outreach height-clip bug | diagnosis done | [0017](SLICES/0017-modern-ui-conformance-and-batch-legibility-audit.md) |
| fix·1 | `0018-outreach-height-clip-fix` | Outreach root flex-sizing so the active-runs banner stops clipping bottom buttons | planned | [0018](SLICES/0018-outreach-height-clip-fix.md) |
| fix·2 | `0019-batch-runner-relocate-and-legibility` | Move batch runner to a new Automate tab; wire live stage + ETA + per-lead failures | planned | [0019](SLICES/0019-batch-runner-relocate-and-legibility.md) |
| fix·3 | `0020-gemini-provider-quota-visibility` | Surface provider 429 RESOURCE_EXHAUSTED as an auto-resuming paused/banner state, not silent failures | planned | [0020](SLICES/0020-gemini-provider-quota-visibility.md) |
| fix·4 | `0021-design-conformance-adoption` | Adopt 0016 tokens in rendered surfaces: kill sub-12px/raw-hex/inline-style sprawl | planned | [0021](SLICES/0021-design-conformance-adoption.md) |
| — | `0022-outreach-queue-reliability-and-deliverability-audit` | Diagnosis: batch stall, bad_email false-positives, multi-email, blacklist/zero-reply, second sender, Gemini reliability, Explorer scroll-clip | diagnosis done | [0022](SLICES/0022-outreach-queue-reliability-and-deliverability-audit.md) |
| rel·1 | `0023-batch-compose-timeout-and-watchdog` | Per-item compose timeout + run-level stall watchdog so a wedged Gemini call can't freeze the batch (F1) | planned | [0023](SLICES/0023-batch-compose-timeout-and-watchdog.md) |
| rel·2 | `0024-validity-gate-microsoft-rejectall-fix` | Reject-all MX (M365) → `unknown`/proceed, not `invalid`; stop discarding real corporate leads (F2) | planned | [0024](SLICES/0024-validity-gate-microsoft-rejectall-fix.md) |
| rel·3 | `0028-explorer-scroll-clip-fix` | Add `min-height:0` to the two Explorer flex containers; reach the bottom of the leads list (F7) | planned | [0028](SLICES/0028-explorer-scroll-clip-fix.md) |
| rel·4 | `0014-reply-visibility-and-reclassification` | Surface the 9 hidden replies; one-tap reclassify (F4 — promoted) | planned | [0014](SLICES/0014-reply-visibility-and-reclassification.md) |
| rel·5 | `0025-best-reachable-email-selection` | Pick the best reachable single address per lead; never multi-send (F3) | planned | [0025](SLICES/0025-best-reachable-email-selection.md) |
| rel·6 | `0026-gemini-503-resilience-and-provider-switch` | Survive 503 storms + Settings-driven provider/model switch; NVIDIA NIM fallback/offload behind a quality bar (F6) | planned | [0026](SLICES/0026-gemini-503-resilience-and-provider-switch.md) |
| rel·7 | `0027-second-sender-rotation` | Add santiagovittordev@gmail.com as a 2nd rotating sender; per-sender cap + dual-inbox scan (F5) | planned | [0027](SLICES/0027-second-sender-rotation.md) |
| bug·1 | `0029-prepare-lane-completion-and-eligibility-reconciliation` | Prepare lane: completion-summary state + drop already-scheduled leads from the staging list (server eligibility excludes active scheduled_sends, client refetches on done) | shipped | [0029](SLICES/0029-prepare-lane-completion-and-eligibility-reconciliation.md) |
| bug·2 | `0030-smtp-probe-invalid-distrust` | Follow-up to 0024: a single SMTP RCPT 5xx no longer condemns an address — M365's edge gives inconsistent in-session RCPT codes, manufacturing false `invalid`. Probe becomes a `valid`-only confirmer; MX-death + bounces remain the authoritative dead signals. One-off clear of stale probe-`invalid`/`mx_ok=1` rows | shipped | [0030](SLICES/0030-smtp-probe-invalid-distrust.md) |
| bug·3 | `0031-batch-analyze-yield-and-gemini-priority` | Batch prepare starved by the post-scrape auto-analyze backlog (25/30 failed on shared single-lane Gemini limiter + Playwright, wall-clock timeouts counting queue-wait). (A) auto-analyze queue yields while a batch is `running` (separate gate, not the user pause flag); (B) batch Gemini calls get Bottleneck priority over backlog vision. Folds in the same-business double-render race guard (F2) | done | [0031](SLICES/0031-batch-analyze-yield-and-gemini-priority.md) |

> **Suggested order (from `0022`):** 0023 → 0024 → 0028 → 0014 → 0025 → 0026 → 0027.

---

## Parked

Carried from the latest handoff so nothing is lost. Not yet ranked into slices;
promote to the table above when picked up.

- Offer-wording editable in Settings.
- Per-business-type send-window editing.
- Migrations-before-prepares cleanup.
- Manual `/send` routed through governor pacing.
- Reply threading.
- Token trimming (composer system prompt).
- Gemini context caching.
- Edit polygon after creation.
- Edit `keyword_query` after creation.
- Cancel a scrape run in-flight.
- `extra_reviews` / fast-mode gosom flags.
- Chatbot-offer track for `held_generic` leads (no website anchor → "I can build you a chatbot/site" offer, like the no-website lane). From `0029`.
- ~~instant-scrape progress UI~~ — promoted to slice `0003-keyword-run-live-status`.
