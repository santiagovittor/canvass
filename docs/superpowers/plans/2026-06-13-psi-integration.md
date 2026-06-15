# PSI Integration (Slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Google PageSpeed Insights API into the premium analysis pass to produce concrete, owner-verifiable mobile performance numbers that feed the cold-email composer as quotable facts.

**Architecture:** After a successful render (`outcome === 'ok'`), call PSI with `strategy=mobile` against `finalUrl`; cache results by URL for 7 days in a new `psi_cache` SQLite table; store extracted fields in a new `psiJson` column on `premium_analyses`; thread the data through the composer prompt and surface it in the EmailComposer panel. Non-ok renders skip PSI entirely (invariant: no successful render → no PSI call). PSI failure always degrades cleanly — rest of the premium pass is unaffected.

**Tech Stack:** undici (server-side HTTP, already in project), Google PageSpeed Insights API v5, better-sqlite3 (direct `sqlite.prepare()` for cache table), Drizzle ORM (schema type only for `psiJson` column), `@google/generative-ai` (already in project for composer).

---

## Decisions & Thresholds (unilateral — note for review)

| Decision | Value | Rationale |
|---|---|---|
| PSI strategy | mobile only | spec says so |
| Fields extracted | mobileScore, lcp, tbt, tti, mobileFriendly | 5 owner-verifiable metrics |
| Cache TTL | 7 days | sites don't optimize week-to-week |
| Retry attempts | 3 total (4 tries), backoff 1.5 s → 3 s → 6 s | transient PSI errors common |
| Request timeout | 30 s | PSI is consistently slow on first cold call |
| Retryable status codes | 429, 500, 502, 503, 504 | transient; 400/403 = permanent failure |
| Composer silence threshold | mobileScore ≥ 75 | "good" range per Google; nothing to mention |
| Composer strong-opener threshold | mobileScore < 50 | "poor" range; cite exact number |
| Composer quiet-nudge range | 50–74 | "needs improvement"; mention only if no better gap |

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `server/src/db/schema.ts` | Modify | Add `psiJson` column to `premiumAnalyses` Drizzle table |
| `server/src/db/index.ts` | Modify | Create `psi_cache` table + migrate `psiJson` column on boot |
| `server/src/env.ts` | Modify | Add optional `PAGESPEED_API_KEY` |
| `.env.example` | Modify | Document `PAGESPEED_API_KEY` |
| `server/src/db/psiCache.ts` | Create | `PsiData` interface + `getCachedPsi()` + `upsertPsiCache()` |
| `server/src/services/psiClient.ts` | Create | `fetchPsi()` — PSI API call, field extraction, retry logic |
| `server/src/db/premium.ts` | Modify | Extend `completePremiumAnalysis()` to accept `psiJson` |
| `server/src/services/premiumAnalyzer.ts` | Modify | Call PSI after ok render; skip on non-ok; pass `psiJson` to complete |
| `server/src/services/geminiComposer.ts` | Modify | Add `psiData` param to `composeEmail()`; inject PSI context block |
| `server/src/routes/outreachQueue.ts` | Modify | Expose `psi` in `GET /premium/:businessId`; pass `psiData` in `/generate` |
| `client/src/components/Outreach/EmailComposer.tsx` | Modify | Extend `premium` prop type; show PSI panel rows |

---

## Task 1: Schema + env + migrations

**Files:**
- Modify: `server/src/db/schema.ts`
- Modify: `server/src/db/index.ts`
- Modify: `server/src/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add `psiJson` to Drizzle schema**

In `server/src/db/schema.ts`, add one line to the `premiumAnalyses` table definition after `detectedSigsJson`:

```typescript
  detectedSigsJson: text('detected_sigs_json'),
  psiJson: text('psi_json'),            // ← add this
  errorMessage: text('error_message'),
```

- [ ] **Step 2: Add `psiCache` table creation and `psiJson` migration to `db/index.ts`**

In `server/src/db/index.ts`, extend the existing `sqlite.exec(`` ` ` ``)` block to include the new table (add before the closing backtick of the existing exec call):

```sql
  CREATE TABLE IF NOT EXISTS psi_cache (
    url TEXT PRIMARY KEY,
    psi_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
```

Then, after the existing `exampleCols` migration block (around line 85), add:

```typescript
// Additive: PSI results column on premium_analyses
const premiumCols = (sqlite.prepare('PRAGMA table_info(premium_analyses)').all() as { name: string }[]).map(r => r.name);
if (!premiumCols.includes('psi_json')) {
  sqlite.exec('ALTER TABLE premium_analyses ADD COLUMN psi_json TEXT');
}
```

- [ ] **Step 3: Add `PAGESPEED_API_KEY` to `env.ts`**

In `server/src/env.ts`, add after `PLAYWRIGHT_WS_URL`:

```typescript
  PAGESPEED_API_KEY: z.string().optional(),
```

- [ ] **Step 4: Document in `.env.example`**

Add after the `GEMINI_API_KEY` line:

```
# Google PageSpeed Insights (optional; premium analysis degrades to UNKNOWN if absent)
PAGESPEED_API_KEY=your-pagespeed-api-key
```

- [ ] **Step 5: Verify tsc clean**

```bash
cd server && npx tsc --noEmit
```

Expected: zero errors.

---

## Task 2: PSI cache DB helper

**Files:**
- Create: `server/src/db/psiCache.ts`

- [ ] **Step 1: Write `psiCache.ts`**

```typescript
import { sqlite } from './index';

export interface PsiData {
  mobileScore: number | null;
  lcp: number | null;      // ms
  tbt: number | null;      // ms
  tti: number | null;      // ms
  mobileFriendly: boolean | null;
  fetchedAt: string;       // ISO — used for TTL check
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getCachedPsi(url: string): PsiData | null {
  const row = (sqlite.prepare('SELECT psi_json, fetched_at FROM psi_cache WHERE url = ?')
    .get(url) as { psi_json: string; fetched_at: string } | undefined);
  if (!row) return null;
  if (Date.now() - new Date(row.fetched_at).getTime() > TTL_MS) return null;
  try {
    return JSON.parse(row.psi_json) as PsiData;
  } catch {
    return null;
  }
}

export function upsertPsiCache(url: string, data: PsiData): void {
  sqlite.prepare(
    `INSERT INTO psi_cache (url, psi_json, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET psi_json = excluded.psi_json, fetched_at = excluded.fetched_at`
  ).run(url, JSON.stringify(data), data.fetchedAt);
}
```

- [ ] **Step 2: Verify tsc clean**

```bash
cd server && npx tsc --noEmit
```

Expected: zero errors.

---

## Task 3: PSI client service

**Files:**
- Create: `server/src/services/psiClient.ts`

- [ ] **Step 1: Write `psiClient.ts`**

```typescript
import { fetch } from 'undici';
import type { PsiData } from '../db/psiCache';

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const RETRY_DELAYS_MS = [1500, 3000, 6000];
const TIMEOUT_MS = 30_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractPsiData(body: unknown): PsiData {
  const b = body as Record<string, unknown>;
  const lhr = b.lighthouseResult as Record<string, unknown> | undefined;
  const audits = (lhr?.audits ?? {}) as Record<string, Record<string, unknown>>;
  const categories = (lhr?.categories ?? {}) as Record<string, Record<string, unknown>>;

  const perfScore = categories.performance?.score;
  const mobileScore = typeof perfScore === 'number' ? Math.round(perfScore * 100) : null;

  const lcpVal = audits['largest-contentful-paint']?.numericValue;
  const lcp = typeof lcpVal === 'number' ? Math.round(lcpVal) : null;

  const tbtVal = audits['total-blocking-time']?.numericValue;
  const tbt = typeof tbtVal === 'number' ? Math.round(tbtVal) : null;

  const ttiVal = audits['interactive']?.numericValue;
  const tti = typeof ttiVal === 'number' ? Math.round(ttiVal) : null;

  const vpScore = audits['viewport']?.score;
  const mobileFriendly = typeof vpScore === 'number' ? vpScore === 1 : null;

  return { mobileScore, lcp, tbt, tti, mobileFriendly, fetchedAt: new Date().toISOString() };
}

export async function fetchPsi(finalUrl: string, apiKey: string): Promise<PsiData | null> {
  const url = `${PSI_ENDPOINT}?url=${encodeURIComponent(finalUrl)}&strategy=mobile&key=${encodeURIComponent(apiKey)}`;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        if (RETRYABLE.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
          console.warn(`[psi] HTTP ${res.status}, retry ${attempt + 1}`);
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        console.error(`[psi] HTTP ${res.status} (non-retryable) for ${finalUrl}`);
        return null;
      }
      const body = await res.json();
      return extractPsiData(body);
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) {
        console.warn(`[psi] network error, retry ${attempt + 1}:`, err);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      console.error(`[psi] failed after all retries for ${finalUrl}:`, err);
      return null;
    }
  }
  return null;
}
```

- [ ] **Step 2: Verify tsc clean**

```bash
cd server && npx tsc --noEmit
```

Expected: zero errors.

---

## Task 4: Wire PSI into premiumAnalyzer + premium DB helper

**Files:**
- Modify: `server/src/db/premium.ts` (extend `completePremiumAnalysis`)
- Modify: `server/src/services/premiumAnalyzer.ts`

- [ ] **Step 1: Extend `completePremiumAnalysis()` in `db/premium.ts`**

Add `psiJson?: string | null` to the parameter object:

```typescript
export function completePremiumAnalysis(id: string, r: {
  status: 'done' | 'failed';
  renderOutcome: string;
  finalUrl: string | null;
  signals: SignalMap;
  cookieWall: boolean;
  consoleErrors: string[];
  paths: { desktop?: string; mobile?: string; html?: string; network?: string };
  detectedSigs: DetectedSig[];
  errorMessage?: string;
  psiJson?: string | null;   // ← add this
}): void {
  db.update(premiumAnalyses).set({
    status: r.status,
    renderOutcome: r.renderOutcome,
    finalUrl: r.finalUrl,
    signalsJson: JSON.stringify(r.signals),
    cookieWall: r.cookieWall ? 1 : 0,
    consoleErrorsJson: JSON.stringify(r.consoleErrors),
    desktopScreenshotPath: r.paths.desktop ?? null,
    mobileScreenshotPath: r.paths.mobile ?? null,
    htmlPath: r.paths.html ?? null,
    networkLogPath: r.paths.network ?? null,
    detectedSigsJson: JSON.stringify(r.detectedSigs),
    psiJson: r.psiJson ?? null,           // ← add this
    errorMessage: r.errorMessage ?? null,
    completedAt: new Date().toISOString(),
  }).where(eq(premiumAnalyses.id, id)).run();
}
```

- [ ] **Step 2: Update `runPremiumAnalysis()` in `premiumAnalyzer.ts`**

Add imports at top of file (after existing imports):

```typescript
import { env } from '../env';
import { fetchPsi } from './psiClient';
import { getCachedPsi, upsertPsiCache } from '../db/psiCache';
import type { PsiData } from '../db/psiCache';
```

Add a helper function after the imports and before `runPremiumAnalysis`:

```typescript
async function runPsi(finalUrl: string): Promise<PsiData | null> {
  if (!env.PAGESPEED_API_KEY) return null;
  const cached = getCachedPsi(finalUrl);
  if (cached) {
    console.log(`[psi] cache hit for ${finalUrl} (fetchedAt: ${cached.fetchedAt})`);
    return cached;
  }
  const result = await fetchPsi(finalUrl, env.PAGESPEED_API_KEY);
  if (result) {
    upsertPsiCache(finalUrl, result);
    console.log(`[psi] fetched for ${finalUrl}: score=${result.mobileScore}`);
  } else {
    console.warn(`[psi] fetch failed for ${finalUrl}, degrading to null`);
  }
  return result;
}
```

Then, in `runPremiumAnalysis()`, replace the ok-render completion block (currently lines 251–264) with:

```typescript
  const paths = writeBundle(row.businessId, row.id, render);
  const signals = detectSignals(render.html!, render.networkUrls, render.finalUrl!);
  const { detectedSigs, signalUpgrades } = scanSignatures(render.html!, render.networkUrls);
  for (const [key, upgrade] of Object.entries(signalUpgrades)) {
    if (upgrade && signals[key]?.state === 'UNKNOWN') signals[key] = upgrade;
  }

  // PSI: only on ok renders with a real finalUrl. Non-ok path above already returned.
  let psiJson: string | null = null;
  try {
    const psiData = await runPsi(render.finalUrl!);
    if (psiData) psiJson = JSON.stringify(psiData);
  } catch (err) {
    console.error('[psi] unexpected error, skipping:', err);
  }

  completePremiumAnalysis(row.id, {
    status: 'done', renderOutcome: 'ok', finalUrl: render.finalUrl,
    signals, cookieWall: render.cookieWallDetected, consoleErrors: render.consoleErrors,
    paths, detectedSigs, psiJson,
  });
  broadcast('premium:progress', { businessId: row.businessId, analysisId: row.id, status: 'done', renderOutcome: 'ok' });
```

- [ ] **Step 3: Verify tsc clean**

```bash
cd server && npx tsc --noEmit
```

Expected: zero errors. Confirm `psiJson` flows from `runPsi()` → `completePremiumAnalysis()` → `db.update()`.

---

## Task 5: Wire PSI into geminiComposer

**Files:**
- Modify: `server/src/services/geminiComposer.ts`

- [ ] **Step 1: Import `PsiData` and add PSI context builder**

Add import at top of `geminiComposer.ts`:

```typescript
import type { PsiData } from '../db/psiCache';
```

Add this function after `buildAnalysisGaps()` (around line 116):

```typescript
function buildPsiContext(psiData: PsiData | null | undefined, isAR: boolean): string {
  if (!psiData || psiData.mobileScore === null) return '';
  const score = psiData.mobileScore;
  if (score >= 75) return '';

  const lcpPart = psiData.lcp !== null
    ? ` LCP (carga del contenido principal): ${(psiData.lcp / 1000).toFixed(1)}s.`
    : '';

  if (isAR) {
    if (score < 50) {
      return `\n\nRENDIMIENTO MÓVIL MEDIDO: puntuación ${score}/100 en Google PageSpeed Insights (móvil).${lcpPart} Son valores reales — el destinatario puede verificarlos en segundos. Si el rendimiento es el gap principal, citar el número exacto: "${score}/100".`;
    }
    return `\n\nRENDIMIENTO MÓVIL: puntuación ${score}/100 en PageSpeed Insights.${lcpPart} Mencionar solo si no hay un problema más urgente.`;
  }
  if (score < 50) {
    return `\n\nMEASURED MOBILE PERFORMANCE: score ${score}/100 on Google PageSpeed Insights.${lcpPart.replace(/LCP \(carga del contenido principal\)/, 'LCP')} Real values — recipient can verify in seconds. If performance is the main gap, cite the exact score: "${score}/100".`;
  }
  return `\n\nMOBILE PERFORMANCE: score ${score}/100 on PageSpeed Insights.${lcpPart.replace(/LCP \(carga del contenido principal\)/, 'LCP')} Mention only if no more urgent gap.`;
}
```

- [ ] **Step 2: Add `psiData` parameter to `composeEmail()`**

Change the function signature:

```typescript
export async function composeEmail(
  business: BusinessForEmail,
  analysis?: WebsiteAnalysis,
  approvedExample?: { subject: string; body: string } | null,
  detectedSigs?: DetectedSig[],
  psiData?: PsiData | null,         // ← add this
): Promise<{ subject: string; body: string; topGap: string | null }> {
```

In the function body, change the `systemPrompt` construction to append the PSI context. Currently it's:

```typescript
  const systemPrompt = (isArgentina ? SYSTEM_ES : SYSTEM_EN)
    .replace('{{OFFER_CONTEXT}}', offerContext + analysisContext)
```

Change to:

```typescript
  const psiContext = buildPsiContext(psiData, isArgentina);
  const systemPrompt = (isArgentina ? SYSTEM_ES : SYSTEM_EN)
    .replace('{{OFFER_CONTEXT}}', offerContext + analysisContext + psiContext)
```

- [ ] **Step 3: Verify tsc clean**

```bash
cd server && npx tsc --noEmit
```

Expected: zero errors. Adding an optional parameter is backwards-compatible — existing callers are unaffected.

---

## Task 6: Update route — GET /premium + /generate

**Files:**
- Modify: `server/src/routes/outreachQueue.ts`

- [ ] **Step 1: Import `PsiData` type at top of route file**

```typescript
import type { PsiData } from '../db/psiCache';
```

- [ ] **Step 2: Expose `psi` in `GET /premium/:businessId`**

In the existing `GET /premium/:businessId` handler, add one field to the response object:

```typescript
  res.json({
    analysis: {
      id: row.id,
      businessId: row.businessId,
      status: row.status,
      renderOutcome: row.renderOutcome,
      finalUrl: row.finalUrl,
      signals: row.signalsJson ? JSON.parse(row.signalsJson) : null,
      cookieWall: row.cookieWall === 1,
      consoleErrors: row.consoleErrorsJson ? JSON.parse(row.consoleErrorsJson) : [],
      desktopScreenshotPath: row.desktopScreenshotPath,
      mobileScreenshotPath: row.mobileScreenshotPath,
      htmlPath: row.htmlPath,
      networkLogPath: row.networkLogPath,
      detectedSigs: row.detectedSigsJson ? JSON.parse(row.detectedSigsJson) : [],
      psi: row.psiJson ? (JSON.parse(row.psiJson) as PsiData) : null,   // ← add this
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    },
  });
```

- [ ] **Step 3: Pass `psiData` in `/generate` handler**

In the `/generate` handler (around line 165–178), add one line and pass it to `composeEmail`:

```typescript
  const premiumRow = getLatestPremiumAnalysis(businessId);
  const detectedSigs: DetectedSig[] | undefined =
    premiumRow?.detectedSigsJson ? JSON.parse(premiumRow.detectedSigsJson) : undefined;
  const psiData: PsiData | null =
    premiumRow?.psiJson ? (JSON.parse(premiumRow.psiJson) as PsiData) : null;   // ← add this

  try {
    const result = await composeEmail({
      name: row.name,
      category: row.category ?? null,
      website: row.website ?? null,
      locCountry: row.locCountry ?? null,
      locNeighbourhood: row.locNeighbourhood ?? null,
      rating: row.rating ?? null,
      reviewCount: row.reviewCount ?? null,
    }, analysis, undefined, detectedSigs, psiData);   // ← pass psiData
```

- [ ] **Step 4: Verify tsc clean**

```bash
cd server && npx tsc --noEmit
```

Expected: zero errors.

---

## Task 7: Client — EmailComposer premium panel

**Files:**
- Modify: `client/src/components/Outreach/EmailComposer.tsx`

- [ ] **Step 1: Extend the `premium` prop type**

Change line 24 (the `EmailComposerProps` interface `premium` field):

```typescript
  premium: {
    status: string;
    renderOutcome: string | null;
    detectedSigs?: DetectedSig[];
    psi?: {
      mobileScore: number | null;
      lcp: number | null;
      tbt: number | null;
      tti: number | null;
      mobileFriendly: boolean | null;
    } | null;
  } | null;
```

- [ ] **Step 2: Add PSI display block in the premium panel**

Find the block that renders `detectedSigs` (the `Detected` section, around line 588). Add the PSI panel block immediately after the closing `</div>` of the detectedSigs section, still inside the outer `hasWebsite && !confirmingSend && premium?.status === 'done'` guard:

```tsx
{hasWebsite && !confirmingSend && premium?.status === 'done' && premium.renderOutcome === 'ok' && premium.psi && premium.psi.mobileScore !== null && (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
      PageSpeed (mobile)
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <PsiChip
        label="Score"
        value={`${premium.psi.mobileScore}/100`}
        bad={premium.psi.mobileScore < 50}
        warn={premium.psi.mobileScore < 75}
      />
      {premium.psi.lcp !== null && (
        <PsiChip
          label="LCP"
          value={`${(premium.psi.lcp / 1000).toFixed(1)}s`}
          bad={premium.psi.lcp > 4000}
          warn={premium.psi.lcp > 2500}
        />
      )}
      {premium.psi.tbt !== null && (
        <PsiChip
          label="TBT"
          value={`${premium.psi.tbt}ms`}
          bad={premium.psi.tbt > 600}
          warn={premium.psi.tbt > 200}
        />
      )}
      {premium.psi.mobileFriendly !== null && (
        <PsiChip
          label="Mobile"
          value={premium.psi.mobileFriendly ? 'OK' : 'issues'}
          bad={!premium.psi.mobileFriendly}
          warn={false}
        />
      )}
    </div>
  </div>
)}
```

Add the `PsiChip` component at the top of the file (before `EmailComposer`):

```tsx
function PsiChip({ label, value, bad, warn }: { label: string; value: string; bad: boolean; warn: boolean }) {
  const color = bad ? 'var(--error)' : warn ? 'var(--warn)' : 'var(--success)';
  const bg = bad ? 'rgba(255,77,109,0.1)' : warn ? 'rgba(245,183,0,0.1)' : 'rgba(74,222,128,0.1)';
  return (
    <span style={{
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      padding: '2px 8px',
      borderRadius: 100,
      background: bg,
      color,
      display: 'inline-flex',
      gap: 4,
      alignItems: 'center',
    }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      {value}
    </span>
  );
}
```

- [ ] **Step 3: Verify tsc clean (client)**

```bash
cd client && npx tsc --noEmit
```

Expected: zero errors. If the `premium` prop type change causes errors in the parent hook/component that passes `premium`, update the type there too (likely `client/src/hooks/useOutreachQueue.ts` or similar).

---

## Verification Gate

Confirm each gate before reporting done:

**Gate 1 — Real PSI data stored and returned**
- Run premium analysis on a real lead with a live website.
- `GET /premium/:businessId` → confirm `psi.mobileScore`, `psi.lcp`, `psi.tbt`, `psi.tti`, `psi.mobileFriendly` are non-null numbers/booleans (not all null).
- Show the actual values in the report.

**Gate 2 — Cache hit**
- Re-run the same lead's premium analysis within 7 days.
- Server logs must show `[psi] cache hit for <url>` — no second API call.
- Confirm `psi.fetchedAt` in the DB row is the same timestamp as the first run.

**Gate 3 — Forced failure**
- Temporarily set `PAGESPEED_API_KEY=invalid-key` (or point to an unreachable URL).
- Run premium analysis: the analysis must complete as `done`; `psi` must be `null` in the response.
- Server logs show `[psi] HTTP 400 (non-retryable)` or `[psi] failed after all retries`.
- No crash, no stuck queue.

**Gate 4 — Non-ok render skip (invariant 3 regression check)**
- Run premium analysis on a lead whose site redirects to a social URL (use a lead with `website` pointing to a known-dead or social-redirect domain).
- Confirm `renderOutcome` is `redirect_social` (or any non-`ok` value) and `psi` is `null` — PSI was never called (no `[psi]` log line for that URL).

**Gate 5 — Composer uses real number**
- Use a lead whose site scored < 50 on PSI (verify from Gate 1).
- Generate a draft: the email body must contain the actual numeric score.
- Use a lead whose site scored ≥ 75: generate a draft → no performance mention.
- Confirm no `ABSENT_VERIFIED` signals anywhere; hedging on other gaps intact.

**Gate 6 — tsc clean**
```bash
cd server && npx tsc --noEmit
cd client && npx tsc --noEmit
```
Both must exit 0. No changes to social enrichment pipeline files.

---

## Inline notes for executor

- `PsiData.fetchedAt` is the source of truth for TTL — `getCachedPsi()` reads it directly. Do not add a separate `cached_at` DB column.
- `runPsi()` in `premiumAnalyzer.ts` wraps the fetch in a `try/catch` so a PSI crash cannot propagate out of `runPremiumAnalysis()`.
- `psiJson` on non-ok render paths is `null` (never set). The `completePremiumAnalysis()` calls on those paths have no `psiJson` key → defaults to `null` via `r.psiJson ?? null`.
- The `LCP` display in `PsiChip` uses `/1000` because PSI returns ms but displaying seconds is more readable to owners.
- Do not change the `composeFollowUp()` function — it doesn't accept analysis data and PSI doesn't apply to follow-ups.
- Do not touch `websiteAnalyzer.ts`, `socialEnricher.ts`, or any enrichment pipeline file.
