---
name: cold-email-outreach
description: >
  Activate for any task touching cold email generation, Gemini prompts,
  email sending, outreach UI, lead queue, draft persistence, or copywriting
  logic in maps-scraper. If a business lead and an email are involved
  in any form — load this skill first.
---

# Cold Email Outreach — maps-scraper

## Stack
- AI: `@google/generative-ai`, model always `gemini-3.5-flash`
- Sending: Nodemailer + Gmail App Password (`GMAIL_APP_PASSWORD`, `GMAIL_FROM`)
- Signature: `credentials/email-signature.html` (file-based, loaded at boot)
- Daily cap: 30/day tracked in `email_sends` table (UTC-3 Buenos Aires)
- Gemini output: strict JSON `{ subject: string, body: string }`

## Language Detection

| `loc_country` | Prompt | Register |
|---|---|---|
| `Argentina` | `prompts/argentina.md` | usted, never vos |
| anything else | `prompts/english.md` | casual American English |

Load the relevant prompt file when writing or auditing any Gemini call.

## Injected Variables (Argentina only)

Compute server-side in `geminiComposer.ts`, replace before API call.

**`{{GREETING}}`** — current time UTC-3:

| Hour | Value |
|---|---|
| 06–12 | `Buenos días` |
| 13–19 | `Buenas tardes` |
| 20–05 | `Buenas noches` |

**`{{PROFESSIONAL_TITLE}}`** — from `category` (case-insensitive match):

| Contains | Title |
|---|---|
| abogad, jurídic, bufete, legal | `Dr./Dra.,` |
| médic, clínic, doctor, salud, odontolog, psicolog | `Dr./Dra.,` |
| arquitect | `Arq.,` |
| contad, contable | `Cdor./Cdora.,` |
| anything else | `` (empty) |

Greeting line: title absent → `Buenos días,` / title present → `Buenos días, Dr./Dra.,`

## Email Validation

Hard reject before display or send:
- Regex: `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`
- Length 6–254, no spaces, single `@`, TLD ≥ 2 chars
- Blocklist: `.local`, `.internal`, `example.com`, `test.com`
- Always parse via `parseEmails(row.emailsJson)?.[0]` — never raw field

## Website Normalization

```ts
normalizeWebsite(raw) → raw.replace(/^https?:\/\//i,'').replace(/^www\./i,'').replace(/\/$/,'').toLowerCase()
```

Present = non-empty after normalization.

## Offer Branch

| Condition | Pitch angle |
|---|---|
| empty/null | Build from scratch — specific to category + barrio |
| has website, no analysis | Concrete gap: design, speed, mobile, SEO, missing feature |
| has website + analysis | Use top signal from `references/website-analysis.md` |

Never say site is bad. Pick ONE gap. Never list multiple.

## Draft Persistence

Table: `outreach_drafts` — `id, business_id (UNIQUE), subject, body, is_ai_draft, created_at, updated_at`

- Upsert on generate and on edit (debounced 1500ms)
- Load on lead selection — skip generate if draft exists
- Delete on successful send
- `has_draft` boolean joined into `getOutreachLeads()` result
- Lead queue: pencil icon (ti-pencil, 11px, teal) when `has_draft` true

## Outreach Status Flow

`null` → queue → `contacted` (sent) / `skip` (excluded) / `replied` / `converted`

## API Routes

```
GET  /api/outreach/leads          paginated 25/page, has_draft, valid_email
GET  /api/outreach/draft/:id      → { subject, body, isAiDraft } | null
PUT  /api/outreach/draft          { businessId, subject, body, isAiDraft }
POST /api/outreach/generate       { businessId } → { subject, body }
POST /api/outreach/analyze        { businessId } → WebsiteAnalysis
POST /api/outreach/send           { businessId, subject, body } → { success, remaining }
GET  /api/outreach/stats          { sent_today, remaining, total_contacted }
GET  /api/outreach/signature      → { html: string | null }
```

## Supporting Files

Load these only when writing or auditing the relevant area:

| File | Load when |
|---|---|
| `prompts/argentina.md` | Writing/auditing AR Gemini system prompt |
| `prompts/english.md` | Writing/auditing EN Gemini system prompt |
| `references/website-analysis.md` | Writing websiteAnalyzer.ts or buildAnalysisContext() |