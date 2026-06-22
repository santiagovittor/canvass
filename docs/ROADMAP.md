# ROADMAP.md — ranked next slices

Pending work, ranked. Each slice gets a spec under `docs/SLICES/<id>-<name>.md`
when picked up (copy `docs/SLICES/_template.md`). Invariants and the reuse-only
registry live in `docs/SPEC.md`.

Status legend: `planned` · `in-progress` · `done`.

| Rank | ID | Intent | Status | Slice file |
|---|---|---|---|---|
| 1 | `0001-auto-enrich-analyze-pipeline` | Auto-run enrich + analyze after every scrape — no manual trigger | planned | _(not created)_ |
| 2 | `0002-daily-operational-digest` | Daily summary of sends / replies / queue health | planned | _(not created)_ |
| 3 | `0003-auto-compose-schedule-high-confidence` | Auto compose + schedule leads above a confidence bar | planned | _(not created)_ |
| 4 | `0004-new-lead-sources-meta-ad-library` | Add Meta Ad Library as a new lead source | planned | _(not created)_ |

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
