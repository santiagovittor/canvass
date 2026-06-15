# Premium Analysis Slice 4 — Gemini Vision Rubrics

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the `visionAbsent` slot in `verifyAbsent()` by sending the render bundle's screenshots to Gemini Vision and getting binary present/absent verdicts per signal. Once `visionAbsent = true`, ABSENT_VERIFIED becomes reachable for UI-visible signals, allowing the composer to make flat (non-hedged) negative claims. Also wire the full `SignalMap` into the composer so it can distinguish ABSENT_VERIFIED (flat) from UNKNOWN (hedged).

**Architecture:** After `detectSignals()` runs on an ok render, `runVision()` reads the desktop+mobile PNGs from disk, encodes them as base64, and sends them to Gemini Vision with a structured JSON rubric prompt covering every vision-checkable signal. The response is a `VisionResult` map (`{ [signalKey]: boolean | null }`) where `true` means "definitely absent." A post-processing step then upgrades any UNKNOWN signal to ABSENT_VERIFIED where the vision verdict is `true`. The upgraded signals are stored in `signalsJson`. The route already exposes `signals` to the client but the composer ignores them — this slice wires `signals` (SignalMap) into `composeEmail()` so that ABSENT_VERIFIED gaps use flat language and PRESENT signals suppress their gap entirely (stronger than the current raw-fetch suppression).

**Tech Stack:** `@google/generative-ai` (already in project, same key as composer), `fs` (read PNG files from disk), `better-sqlite3`/Drizzle (additive `visionJson` column). No new packages.

---

## Invariants — never weaken these

- Vision pass runs ONLY on `outcome === 'ok'` renders with both screenshot paths present. If either PNG is missing or unreadable, vision pass is skipped entirely (non-fatal).
- Vision `true` + UNKNOWN = ABSENT_VERIFIED. Vision `false` or `null` = stays UNKNOWN. Vision can never set PRESENT — that is detectSignals' job.
- `redirect_social` path: vision never runs; `visionJson = null`.
- Gemini Vision failure (any exception, timeout, malformed JSON) is caught and logged; analysis completes with `visionJson = null` and all affected signals stay UNKNOWN. No crash, no stuck queue.
- `hasSSL` is a protocol fact — vision pass does not touch it.
- Composer hedges `a primera vista` ONLY for UNKNOWN signals. ABSENT_VERIFIED uses flat language. PRESENT signals suppress their gap as before.

---

## Vision-checkable signals

These are UI-visible in screenshots. All others (`hasAnalytics`, `hasStructuredData`, `hasOpenGraph`, `hasFavicon`, `hasViewportMeta`) are code/meta-level — not included in the vision prompt.

| Signal key | What to look for |
|---|---|
| `hasOnlineBooking` | Booking/reservation button, embedded calendar widget, "Reservar turno" CTA |
| `hasWhatsappLink` | WhatsApp floating bubble or button anywhere on page |
| `hasMenuOrServices` | Menu list, services section, pricing table |
| `hasLiveChatWidget` | Chat bubble or widget in any corner |
| `hasContactForm` | Visible form with input fields (name, email, message, submit button) |
| `hasTestimonials` | Star ratings, review cards, customer quotes |
| `hasTelLink` | Phone number printed anywhere on page |
| `hasVisibleEmail` | Email address printed anywhere on page |
| `hasNewsletterForm` | Newsletter/email-signup input + subscribe button |
| `hasBlog` | Blog section, news section, article links |

---

## Decisions (unilateral — note for review)

| Decision | Value | Rationale |
|---|---|---|
| Images sent | Desktop + mobile screenshots, both | Mobile shows responsive breakpoints; desktop shows full layout. Both together = higher confidence. |
| Image encoding | base64 inline | Gemini SDK inlineData; no URL hosting needed |
| Gemini model | Same as composer (`gemini-3.5-flash`) | Already configured; supports image input. If model update needed, change one constant. |
| Response format | Single JSON object, all signals in one call | Avoids 10 separate API calls; cheaper; one parse failure = skip vision gracefully |
| Verdict semantics | `true` = absent, `false` = cannot confirm absent, `null` = not enough visible | Only `true` upgrades to ABSENT_VERIFIED |
| Timeout | 30 s | Vision calls are slower than text |
| Retry | None — single attempt | Vision is best-effort enrichment; transient failure → stay UNKNOWN, not worth 90s retry |
| `visionJson` column | Stored on `premium_analyses` | Allows retrospective debugging + future UI showing vision reasoning |

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `server/src/db/schema.ts` | Modify | Add `visionJson` column to `premiumAnalyses` |
| `server/src/db/index.ts` | Modify | ADD COLUMN migration for `vision_json` |
| `server/src/db/premium.ts` | Modify | Add `visionJson?: string \| null` to `completePremiumAnalysis` params |
| `server/src/services/visionAnalyzer.ts` | **Create** | `runVision()` — read PNGs, call Gemini, return `VisionResult` |
| `server/src/services/premiumAnalyzer.ts` | Modify | Call `runVision()` after detectSignals; upgrade UNKNOWN → ABSENT_VERIFIED; pass `visionJson` |
| `server/src/services/geminiComposer.ts` | Modify | Add `signals` param to `composeEmail()`; flat language for ABSENT_VERIFIED in gap builders |
| `server/src/routes/outreachQueue.ts` | Modify | Pass `signals` from premiumRow to `composeEmail()` in `/generate` |
| `client/src/lib/outreachApi.ts` | Modify | Add `visionJson` to `PremiumAnalysis` interface (optional, for debugging) |

---

## Task 1: DB schema + migration

**Files:**
- Modify: `server/src/db/schema.ts`
- Modify: `server/src/db/index.ts`

- [ ] **Step 1: Add `visionJson` to Drizzle schema**

In `server/src/db/schema.ts`, add after `psiJson`:

```typescript
  psiJson: text('psi_json'),
  visionJson: text('vision_json'),       // ← add this
  errorMessage: text('error_message'),
```

- [ ] **Step 2: Add migration to `db/index.ts`**

After the existing `psi_json` migration block, add:

```typescript
// Additive: Gemini vision rubric results on premium_analyses
if (!premiumCols.includes('vision_json')) {
  sqlite.exec('ALTER TABLE premium_analyses ADD COLUMN vision_json TEXT');
}
```

Note: `premiumCols` is already computed above for the `psi_json` migration — reuse it, or re-query if the blocks are not adjacent.

- [ ] **Step 3: Verify tsc clean**

```bash
cd server && npx tsc --noEmit
```

Expected: zero errors. Drizzle schema update is purely additive.

---

## Task 2: Vision analyzer service

**Files:**
- Create: `server/src/services/visionAnalyzer.ts`

- [ ] **Step 1: Write `visionAnalyzer.ts`**

```typescript
import fs from 'fs';
import path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../env';
import { dataDir } from '../db';

export interface VisionResult {
  hasOnlineBooking: boolean | null;
  hasWhatsappLink: boolean | null;
  hasMenuOrServices: boolean | null;
  hasLiveChatWidget: boolean | null;
  hasContactForm: boolean | null;
  hasTestimonials: boolean | null;
  hasTelLink: boolean | null;
  hasVisibleEmail: boolean | null;
  hasNewsletterForm: boolean | null;
  hasBlog: boolean | null;
}

const VISION_KEYS: (keyof VisionResult)[] = [
  'hasOnlineBooking', 'hasWhatsappLink', 'hasMenuOrServices', 'hasLiveChatWidget',
  'hasContactForm', 'hasTestimonials', 'hasTelLink', 'hasVisibleEmail',
  'hasNewsletterForm', 'hasBlog',
];

const RUBRIC_PROMPT = `You are inspecting screenshots of a business website (desktop and mobile views).

For each signal below, answer whether the element is DEFINITIVELY ABSENT from what is visible.
- true  = you are certain this element does NOT appear anywhere in the screenshots
- false = the element appears to be present, OR you cannot confirm it is absent
- null  = the screenshots don't show enough of the page to make a judgment

Answer ONLY with valid JSON, no markdown, no extra text:
{
  "hasOnlineBooking": true|false|null,
  "hasWhatsappLink": true|false|null,
  "hasMenuOrServices": true|false|null,
  "hasLiveChatWidget": true|false|null,
  "hasContactForm": true|false|null,
  "hasTestimonials": true|false|null,
  "hasTelLink": true|false|null,
  "hasVisibleEmail": true|false|null,
  "hasNewsletterForm": true|false|null,
  "hasBlog": true|false|null
}

Signal definitions:
- hasOnlineBooking: any booking/scheduling widget, "Reservar turno" button, or embedded calendar
- hasWhatsappLink: a WhatsApp floating bubble, icon button, or "Escribinos por WhatsApp" CTA
- hasMenuOrServices: a menu list, services section, pricing table, or "Nuestros servicios" area
- hasLiveChatWidget: a live chat bubble in any screen corner (Tawk, Crisp, Tidio, etc.)
- hasContactForm: a form with labeled input fields and a submit button
- hasTestimonials: star ratings, review cards, customer quotes, or a "Testimonios" section
- hasTelLink: a phone number printed anywhere (including footer)
- hasVisibleEmail: an email address printed anywhere (including footer)
- hasNewsletterForm: a newsletter/email-signup input field with a subscribe button
- hasBlog: a blog section, "Novedades", news articles, or post links

Be conservative: if the element might appear below the fold or on a section not fully visible, answer false or null, not true.`;

function readImageAsBase64(relPath: string): string | null {
  try {
    const abs = path.join(dataDir, relPath);
    return fs.readFileSync(abs).toString('base64');
  } catch {
    return null;
  }
}

export async function runVision(
  desktopPath: string | null,
  mobilePath: string | null,
): Promise<VisionResult | null> {
  if (!env.GEMINI_API_KEY) return null;
  if (!desktopPath && !mobilePath) return null;

  const images: { inlineData: { data: string; mimeType: string } }[] = [];
  if (desktopPath) {
    const b64 = readImageAsBase64(desktopPath);
    if (b64) images.push({ inlineData: { data: b64, mimeType: 'image/png' } });
  }
  if (mobilePath) {
    const b64 = readImageAsBase64(mobilePath);
    if (b64) images.push({ inlineData: { data: b64, mimeType: 'image/png' } });
  }
  if (images.length === 0) return null;

  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash',
    generationConfig: { responseMimeType: 'application/json' },
  });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [...images, { text: RUBRIC_PROMPT }] }],
  });

  const text = result.response.text().trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('[vision] non-JSON response:', text.slice(0, 200));
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    console.error('[vision] unexpected response shape');
    return null;
  }

  const raw = parsed as Record<string, unknown>;
  const out: VisionResult = {} as VisionResult;
  for (const key of VISION_KEYS) {
    const v = raw[key];
    out[key] = v === true ? true : v === false ? false : null;
  }
  return out;
}
```

- [ ] **Step 2: Verify tsc clean**

```bash
cd server && npx tsc --noEmit
```

Expected: zero errors.

---

## Task 3: Wire vision into premiumAnalyzer

**Files:**
- Modify: `server/src/services/premiumAnalyzer.ts`
- Modify: `server/src/db/premium.ts`

- [ ] **Step 1: Add import to `premiumAnalyzer.ts`**

After existing imports, add:

```typescript
import { runVision, type VisionResult } from './visionAnalyzer';
```

- [ ] **Step 2: Add `upgradeWithVision()` helper**

Add this function before `runPremiumAnalysis`:

```typescript
function upgradeWithVision(signals: SignalMap, vision: VisionResult): void {
  const VISION_KEYS: (keyof VisionResult)[] = [
    'hasOnlineBooking', 'hasWhatsappLink', 'hasMenuOrServices', 'hasLiveChatWidget',
    'hasContactForm', 'hasTestimonials', 'hasTelLink', 'hasVisibleEmail',
    'hasNewsletterForm', 'hasBlog',
  ];
  for (const key of VISION_KEYS) {
    if (vision[key] === true && signals[key]?.state === 'UNKNOWN') {
      signals[key] = {
        state: 'ABSENT_VERIFIED',
        evidence: { kind: 'vision', value: 'not visible in desktop + mobile screenshots' },
        checkedBy: [...(signals[key]?.checkedBy ?? []), 'vision'],
      };
    }
  }
}
```

- [ ] **Step 3: Call `runVision()` in the ok-render path**

In `runPremiumAnalysis`, after the existing PSI block and before `completePremiumAnalysis`, add:

```typescript
  // Vision pass: upgrade UNKNOWN signals to ABSENT_VERIFIED where Gemini confirms absence.
  // Runs only when screenshots exist. Any failure degrades silently to visionJson = null.
  let visionJson: string | null = null;
  try {
    const vision = await runVision(paths.desktop ?? null, paths.mobile ?? null);
    if (vision) {
      upgradeWithVision(signals, vision);
      visionJson = JSON.stringify(vision);
      console.log(`[vision] done for ${render.finalUrl}`);
    }
  } catch (err) {
    console.error('[vision] unexpected error, skipping:', err);
  }
```

Then pass `visionJson` to `completePremiumAnalysis`:

```typescript
  completePremiumAnalysis(row.id, {
    status: 'done', renderOutcome: 'ok', finalUrl: render.finalUrl,
    signals, cookieWall: render.cookieWallDetected, consoleErrors: render.consoleErrors,
    paths, detectedSigs, psiJson, visionJson,
  });
```

- [ ] **Step 4: Update `completePremiumAnalysis` in `db/premium.ts`**

Add `visionJson?: string | null` to the parameter type and the `db.update()` call:

```typescript
export function completePremiumAnalysis(id: string, r: {
  // ... existing fields ...
  psiJson?: string | null;
  visionJson?: string | null;   // ← add
  errorMessage?: string;
}): void {
  db.update(premiumAnalyses).set({
    // ... existing fields ...
    psiJson: r.psiJson ?? null,
    visionJson: r.visionJson ?? null,   // ← add
    errorMessage: r.errorMessage ?? null,
    completedAt: new Date().toISOString(),
  }).where(eq(premiumAnalyses.id, id)).run();
}
```

Non-ok paths already pass no `visionJson` → defaults to `null` via `r.visionJson ?? null`. No changes needed there.

- [ ] **Step 5: Verify tsc clean**

```bash
cd server && npx tsc --noEmit
```

Expected: zero errors. Confirm `upgradeWithVision()` mutates `signals` in-place before `completePremiumAnalysis` stores it, so `signalsJson` in the DB already contains the upgraded states.

---

## Task 4: Composer — flat language for ABSENT_VERIFIED

**Files:**
- Modify: `server/src/services/geminiComposer.ts`

The composer currently hedges all negative claims ("no muestra X a primera vista") because absence was never verified. With ABSENT_VERIFIED now reachable, we can make flat claims for those signals. The `WebsiteAnalysis` (raw-fetch) doesn't know about tri-state — signals are passed separately.

- [ ] **Step 1: Import `SignalMap` type**

At top of `geminiComposer.ts`, add:

```typescript
import type { SignalMap } from '../db/premium';
```

- [ ] **Step 2: Add `signals` optional parameter to `composeEmail()`**

Change signature:

```typescript
export async function composeEmail(
  business: BusinessForEmail,
  analysis?: WebsiteAnalysis,
  approvedExample?: { subject: string; body: string } | null,
  detectedSigs?: DetectedSig[],
  psiData?: PsiData | null,
  signals?: SignalMap | null,   // ← add
): Promise<{ subject: string; body: string; topGap: string | null }>
```

- [ ] **Step 3: Update `buildAnalysisGaps()` and `buildAnalysisContext()` to accept signals**

Add `signals?: SignalMap | null` as last parameter to both functions.

Inside each, add a helper at the top:

```typescript
  function verified(key: string): boolean {
    return signals?.[key]?.state === 'ABSENT_VERIFIED';
  }
  function unknown(key: string): boolean {
    return !signals || signals[key]?.state === 'UNKNOWN' || signals[key]?.state === undefined;
  }
```

Then update each gap entry:
- If `verified(key)`: use flat language (no "a primera vista"), higher priority. Only include if raw-fetch also says absent (don't contradict PRESENT from raw fetch).
- If `unknown(key)` (or no signals): keep current hedged "a primera vista" language.
- If signal is PRESENT: suppress the gap (already done via `detectedSigs` for some; `signals` gives broader coverage).

Example — `hasOnlineBooking` in `buildAnalysisGaps`:

```typescript
  if (isBookable && !a.hasOnlineBooking && !hasBookingSig) {
    if (verified('hasOnlineBooking')) {
      raw.push({ label: 'no tiene sistema de turnos online', priority: 11 });
    } else {
      raw.push({ label: 'no muestra un sistema de turnos online a primera vista', priority: 10 });
    }
  }
```

Apply the same pattern to every hedged gap:

| Signal | Hedged (UNKNOWN) | Flat (ABSENT_VERIFIED) | Priority delta |
|---|---|---|---|
| `hasOnlineBooking` | `no muestra un sistema de turnos online a primera vista` | `no tiene sistema de turnos online` | +1 |
| `hasWhatsappLink` | `no muestra un botón de WhatsApp a primera vista` | `no tiene botón de WhatsApp` | +1 |
| `hasContactForm` | `no muestra un formulario de contacto a primera vista` | `no tiene formulario de contacto` | +1 |
| `hasMenuOrServices` | `no muestra el menú online a primera vista` | `no tiene menú ni servicios publicados` | +1 |
| `hasTestimonials` | `no muestra testimonios de clientes a primera vista` | `no tiene testimonios de clientes` | +1 |

`hasViewportMeta` and `hasSSL` already produce flat claims (not vision-dependent) — don't change them.

- [ ] **Step 4: Also update `buildAnalysisContext()` for the single-gap EN path**

Same pattern: if `verified(key)`, drop "at first glance" / "a primera vista" qualifier from the single injected finding.

- [ ] **Step 5: Pass `signals` through in `composeEmail()` body**

```typescript
  const analysisContext = analysis?.loadedSuccessfully
    ? buildAnalysisContext(business, analysis, isArgentina, detectedSigs, signals)
    : '';
  // ...
  const analysisGaps = analysis?.loadedSuccessfully
    ? buildAnalysisGaps(business, analysis, detectedSigs, signals)
    : { gaps: [] as string[], count: 0 };
```

- [ ] **Step 6: Verify tsc clean**

```bash
cd server && npx tsc --noEmit
```

Expected: zero errors. `signals` is optional everywhere — no call sites break.

---

## Task 5: Route — pass `signals` to composer

**Files:**
- Modify: `server/src/routes/outreachQueue.ts`

- [ ] **Step 1: Import `SignalMap` type**

```typescript
import type { SignalMap } from '../db/premium';
```

- [ ] **Step 2: Parse signals in `/generate` handler**

After the existing `psiData` line, add:

```typescript
  const signals: SignalMap | null =
    premiumRow?.signalsJson ? (JSON.parse(premiumRow.signalsJson) as SignalMap) : null;
```

- [ ] **Step 3: Pass `signals` to `composeEmail()`**

```typescript
    const result = await composeEmail({
      name: row.name,
      category: row.category ?? null,
      website: row.website ?? null,
      locCountry: row.locCountry ?? null,
      locNeighbourhood: row.locNeighbourhood ?? null,
      rating: row.rating ?? null,
      reviewCount: row.reviewCount ?? null,
    }, analysis, undefined, detectedSigs, psiData, signals);
```

- [ ] **Step 4: Expose `visionJson` in `GET /premium/:businessId` (optional, for debugging)**

Add one field to the existing response object:

```typescript
      visionJson: row.visionJson ?? null,
```

- [ ] **Step 5: Verify tsc clean**

```bash
cd server && npx tsc --noEmit
```

Expected: zero errors.

---

## Task 6: Client API type update

**Files:**
- Modify: `client/src/lib/outreachApi.ts`

- [ ] **Step 1: Add `visionJson` to `PremiumAnalysis`**

Add one field (optional — existing rows will have null):

```typescript
  visionJson: string | null;
```

- [ ] **Step 2: Verify tsc clean (client)**

```bash
cd client && npx tsc --noEmit
```

Expected: zero errors. No UI change in this slice — `visionJson` is exposed for debugging only; the visible effect is flat vs. hedged language in generated emails.

---

## Verification Gates

Confirm each gate before reporting done.

**Gate 1 — ABSENT_VERIFIED signals appear in DB**
- Run premium analysis on a lead with a real website (one that has no WhatsApp and no contact form visible).
- Query: `SELECT signals_json FROM premium_analyses WHERE business_id = '<id>' ORDER BY created_at DESC LIMIT 1`.
- At least one signal must show `"state": "ABSENT_VERIFIED"` with `"checkedBy": [..., "vision"]`.
- Show the full signals object in the report.

**Gate 2 — Vision logs appear**
- After the same run, server logs must show `[vision] done for <url>`.
- No `[vision] unexpected error` lines.

**Gate 3 — Vision failure degrades cleanly**
- Temporarily break Gemini key: set `GEMINI_API_KEY=invalid_key_test`.
- Run premium analysis: analysis must complete as `done`; all signals stay UNKNOWN; `visionJson = null`.
- Server logs show `[vision] non-JSON response:` or a network/API error — no crash.

**Gate 4 — Flat language in generated email**
- Use a lead whose premium analysis produced ≥ 1 ABSENT_VERIFIED signal.
- Call `POST /generate` for that businessId.
- Verify the email body contains flat language ("no tiene X") and NOT the hedged form ("no muestra X a primera vista") for that specific signal.
- Show the generated subject + body.

**Gate 5 — PRESENT signal suppresses gap (regression check)**
- Use a lead whose site has WhatsApp confirmed PRESENT (from detectedSigs or signals).
- Generate email: must NOT mention "no tiene botón de WhatsApp" or any WhatsApp gap.

**Gate 6 — redirect_social path: visionJson = null, no ABSENT_VERIFIED**
- Trigger premium analysis on the instagram.com lead (ChIJHx1sX1VDaS8RVUgDovnkNyc).
- Confirm `visionJson = null` and all signals are UNKNOWN (none ABSENT_VERIFIED).

**Gate 7 — tsc clean**
```bash
cd server && npx tsc --noEmit
cd client && npx tsc --noEmit
```
Both must exit 0.

---

## Inline notes for executor

- `upgradeWithVision()` mutates the `signals` object in-place after `detectSignals()` runs. The mutation happens before `completePremiumAnalysis()` stores `signalsJson`, so the DB always reflects the post-vision state. No separate vision-signals column needed.
- `generationConfig: { responseMimeType: 'application/json' }` tells Gemini to return JSON directly — reduces parse failures. If the model ignores this and wraps in markdown fences, add a JSON extraction step similar to the one in `callGemini()`.
- The `priority +1` for ABSENT_VERIFIED gaps ensures they beat their UNKNOWN counterparts in gap ranking. Example: ABSENT_VERIFIED `hasOnlineBooking` (priority 11) beats UNKNOWN `hasViewportMeta` (priority 8), making the email lead with the verified booking gap.
- `composeFollowUp()` does not accept signals — follow-ups don't re-analyze the site. Do not add signals to it.
- Do not touch `websiteAnalyzer.ts`, `socialEnricher.ts`, `psiClient.ts`, or `psiCache.ts`.
- The `'vision'` value in `checkedBy` must match the `DetectorKind` union. Add `'vision'` to that union in `db/premium.ts` if it's not already there: `export type DetectorKind = 'dom' | 'network' | 'raw_fetch' | 'vision';`. It is already defined — verify before adding.
