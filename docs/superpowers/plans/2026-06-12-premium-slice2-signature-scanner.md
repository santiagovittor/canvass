# Premium Analysis Slice 2 — Signature Scanner

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a data-driven signature scanner to the premium analysis pass that identifies specific widgets/platforms by name, produces evidence, upgrades the tri-state signal map, and surfaces findings in the UI and email composer.

**Architecture:** A TS data module holds all signatures (regex matchers + category + optional signal-merge key). The scanner runs after `detectSignals()` in `runPremiumAnalysis`, merging UNKNOWN signals to PRESENT where matched and building a `detectedSigs[]` list stored in a new additive DB column. The route exposes it; the composer consumes it to suppress false "you don't have X" gaps; the UI shows a grouped list with evidence.

**Tech Stack:** TypeScript, better-sqlite3/Drizzle, server-only — no new packages; client-side React state + inline expand for UI.

---

## Invariants — never weaken these

- Tri-state: signature match → PRESENT with evidence. No match → signal stays UNKNOWN. Never ABSENT_VERIFIED from scanner.
- `redirect_social` renders: scanner skips entirely; `detectedSigs = []`.
- All schema changes additive only. No existing column altered.
- `verifyAbsent()` gate unchanged — still structurally unreachable until vision pass.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `server/src/data/signatureLibrary.ts` | **Create** | Signature data module — all matchers live here |
| `server/src/db/schema.ts` | Modify | Add `detectedSigsJson` column to `premiumAnalyses` |
| `server/src/db/migrate.ts` | Modify | ALTER TABLE migration for new column |
| `server/src/db/premium.ts` | Modify | Add `DetectedSig` type; update `completePremiumAnalysis` to accept+store `detectedSigs` |
| `server/src/services/premiumAnalyzer.ts` | Modify | Add `scanSignatures()`; call from `runPremiumAnalysis`; merge into signals + pass to complete |
| `server/src/services/geminiComposer.ts` | Modify | Add `detectedSigs?` param to `composeEmail`; suppress false gaps |
| `server/src/routes/outreachQueue.ts` | Modify | Expose `detectedSigs` in `GET /premium/:businessId`; fetch & pass to `/generate` |
| `client/src/lib/outreachApi.ts` | Modify | Add `DetectedSig` interface; add `detectedSigs` to `PremiumAnalysis` |
| `client/src/components/Outreach/EmailComposer.tsx` | Modify | Show signature list grouped by category, evidence on click-expand |
| `client/src/pages/Outreach.tsx` | Modify | Extend `premium` state to include `detectedSigs`; fetch on lead select + SSE done |

---

## Task 1 — Signature library

**Files:**
- Create: `server/src/data/signatureLibrary.ts`

- [ ] **Step 1: Write the file**

```typescript
export type SigCategory = 'whatsapp' | 'chat' | 'booking' | 'forms' | 'builder' | 'analytics';

export interface Signature {
  id: string;
  name: string;
  category: SigCategory;
  /** If set, a match upgrades this key in the existing SignalMap (UNKNOWN → PRESENT). */
  signalKey?: string;
  /** Regex tested against each network request URL. */
  network?: RegExp;
  /** Regex tested against rendered HTML string. */
  dom?: RegExp;
}

export const SIGNATURES: Signature[] = [
  // ── WhatsApp ─────────────────────────────────────────────────────────────────
  {
    id: 'whatsapp-link',
    name: 'WhatsApp Link',
    category: 'whatsapp',
    signalKey: 'hasWhatsappLink',
    network: /wa\.me\/|api\.whatsapp\.com|wa\.link\//i,
    dom: /wa\.me\/|api\.whatsapp\.com|whatsapp:\/\//i,
  },
  {
    id: 'joinchat',
    name: 'Joinchat Plugin',
    category: 'whatsapp',
    signalKey: 'hasWhatsappLink',
    network: /joinchat/i,
    dom: /joinchat/i,
  },
  {
    id: 'getbutton',
    name: 'GetButton',
    category: 'whatsapp',
    signalKey: 'hasWhatsappLink',
    network: /getbutton\.io/i,
    dom: /getbutton\.io/i,
  },
  {
    id: 'elfsight-whatsapp',
    name: 'Elfsight WhatsApp',
    category: 'whatsapp',
    signalKey: 'hasWhatsappLink',
    network: /elfsight\.com/i,
    dom: /elfsight-app[^"']*whatsapp|eapps-whatsapp/i,
  },

  // ── Chat widgets ─────────────────────────────────────────────────────────────
  {
    id: 'tawk-to',
    name: 'Tawk.to',
    category: 'chat',
    signalKey: 'hasLiveChatWidget',
    network: /embed\.tawk\.to/i,
    dom: /tawk\.to/i,
  },
  {
    id: 'crisp',
    name: 'Crisp',
    category: 'chat',
    signalKey: 'hasLiveChatWidget',
    network: /client\.crisp\.chat/i,
    dom: /crisp\.chat/i,
  },
  {
    id: 'tidio',
    name: 'Tidio',
    category: 'chat',
    signalKey: 'hasLiveChatWidget',
    network: /code\.tidio\.co|static\.tidio\.com/i,
    dom: /tidio/i,
  },
  {
    id: 'intercom',
    name: 'Intercom',
    category: 'chat',
    signalKey: 'hasLiveChatWidget',
    network: /widget\.intercom\.io|js\.intercomcdn\.com/i,
    dom: /intercomcdn|intercom\.io/i,
  },
  {
    id: 'zendesk-chat',
    name: 'Zendesk Chat',
    category: 'chat',
    signalKey: 'hasLiveChatWidget',
    network: /v2\.zopim\.com|static\.zdassets\.com/i,
    dom: /zopim|zdassets/i,
  },
  {
    id: 'hubspot-chat',
    name: 'HubSpot Chat',
    category: 'chat',
    signalKey: 'hasLiveChatWidget',
    network: /js\.hs-scripts\.com|js\.hubspot\.com/i,
    dom: /hubspot|hs-chat/i,
  },

  // ── Booking / scheduling ─────────────────────────────────────────────────────
  {
    id: 'calendly',
    name: 'Calendly',
    category: 'booking',
    signalKey: 'hasOnlineBooking',
    network: /calendly\.com/i,
    dom: /calendly\.com/i,
  },
  {
    id: 'fresha',
    name: 'Fresha',
    category: 'booking',
    signalKey: 'hasOnlineBooking',
    network: /fresha\.com/i,
    dom: /fresha\.com/i,
  },
  {
    id: 'booksy',
    name: 'Booksy',
    category: 'booking',
    signalKey: 'hasOnlineBooking',
    network: /booksy\.com/i,
    dom: /booksy\.com/i,
  },
  {
    id: 'opentable',
    name: 'OpenTable',
    category: 'booking',
    signalKey: 'hasOnlineBooking',
    network: /opentable\.com/i,
    dom: /opentable\.com/i,
  },
  {
    id: 'simplybook',
    name: 'SimplyBook.me',
    category: 'booking',
    signalKey: 'hasOnlineBooking',
    network: /simplybook\.me|simplybook\.it/i,
    dom: /simplybook\.(me|it)/i,
  },
  {
    id: 'agendapro',
    name: 'AgendaPro',
    category: 'booking',
    signalKey: 'hasOnlineBooking',
    network: /agendapro\.com/i,
    dom: /agendapro\.com/i,
  },
  {
    id: 'reservo',
    name: 'Reservo',
    category: 'booking',
    signalKey: 'hasOnlineBooking',
    network: /reservo\.com/i,
    dom: /reservo\.com/i,
  },
  {
    id: 'acuity',
    name: 'Acuity Scheduling',
    category: 'booking',
    signalKey: 'hasOnlineBooking',
    network: /acuityscheduling\.com/i,
    dom: /acuityscheduling\.com/i,
  },

  // ── Embedded forms ───────────────────────────────────────────────────────────
  {
    id: 'typeform',
    name: 'Typeform',
    category: 'forms',
    signalKey: 'hasContactForm',
    network: /embed\.typeform\.com|form\.typeform\.com/i,
    dom: /typeform\.com/i,
  },
  {
    id: 'google-forms',
    name: 'Google Forms',
    category: 'forms',
    signalKey: 'hasContactForm',
    network: /docs\.google\.com\/forms/i,
    dom: /docs\.google\.com\/forms/i,
  },
  {
    id: 'jotform',
    name: 'JotForm',
    category: 'forms',
    signalKey: 'hasContactForm',
    network: /form\.jotform\.com/i,
    dom: /jotform\.com/i,
  },

  // ── Builders / CMS (no signalKey — new category) ─────────────────────────────
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'builder',
    dom: /wp-content\/|wp-json\//i,
  },
  {
    id: 'elementor',
    name: 'Elementor',
    category: 'builder',
    network: /elementor/i,
    dom: /elementor-/i,
  },
  {
    id: 'divi',
    name: 'Divi',
    category: 'builder',
    dom: /et_pb_|et-pb-/i,
  },
  {
    id: 'wix',
    name: 'Wix',
    category: 'builder',
    network: /static\.wixstatic\.com|wix-code/i,
    dom: /wixsite\.com|wixstatic/i,
  },
  {
    id: 'squarespace',
    name: 'Squarespace',
    category: 'builder',
    network: /static\.squarespace\.com/i,
    dom: /squarespace\.com|static\.squarespace/i,
  },
  {
    id: 'tiendanube',
    name: 'Tienda Nube',
    category: 'builder',
    network: /tiendanube\.com|nuvemshop\.com/i,
    dom: /tiendanube\.com|nuvemshop\.com|mitiendanube\.com/i,
  },
  {
    id: 'mercadoshops',
    name: 'Mercado Shops',
    category: 'builder',
    network: /mlstatic\.com\/frontend\/shops/i,
    dom: /mercadoshops|mlstatic\.com\/frontend\/shops/i,
  },
  {
    id: 'godaddy-builder',
    name: 'GoDaddy Builder',
    category: 'builder',
    network: /wsb\.com/i,
    dom: /websitebuilder\.godaddy|godaddy.*wsb/i,
  },

  // ── Analytics / pixels ───────────────────────────────────────────────────────
  {
    id: 'ga4',
    name: 'Google Analytics 4',
    category: 'analytics',
    signalKey: 'hasAnalytics',
    network: /googletagmanager\.com|google-analytics\.com/i,
    dom: /gtag\(|G-[A-Z0-9]{6,}|googletagmanager\.com/i,
  },
  {
    id: 'meta-pixel',
    name: 'Meta Pixel',
    category: 'analytics',
    signalKey: 'hasAnalytics',
    network: /connect\.facebook\.net.*fbevents|facebook\.net/i,
    dom: /fbq\(|connect\.facebook\.net/i,
  },
];
```

- [ ] **Step 2: Verify TypeScript compiles (run from Docker container)**

```bash
# In Docker container shell:
npx tsc --noEmit
```
Expected: no errors on the new file (it has no imports yet, pure data).

---

## Task 2 — DB schema + migration + types

**Files:**
- Modify: `server/src/db/schema.ts:56-72`
- Modify: `server/src/db/migrate.ts:91-111`
- Modify: `server/src/db/premium.ts`

- [ ] **Step 1: Add column to schema**

In `server/src/db/schema.ts`, in the `premiumAnalyses` table definition, add after `networkLogPath`:

```typescript
  detectedSigsJson: text('detected_sigs_json'),
```

Full resulting premiumAnalyses table definition:
```typescript
export const premiumAnalyses = sqliteTable('premium_analyses', {
  id: text('id').primaryKey(),
  businessId: text('business_id').notNull(),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed'] }).notNull().default('pending'),
  renderOutcome: text('render_outcome'),
  finalUrl: text('final_url'),
  signalsJson: text('signals_json'),
  cookieWall: integer('cookie_wall').notNull().default(0),
  consoleErrorsJson: text('console_errors_json'),
  desktopScreenshotPath: text('desktop_screenshot_path'),
  mobileScreenshotPath: text('mobile_screenshot_path'),
  htmlPath: text('html_path'),
  networkLogPath: text('network_log_path'),
  detectedSigsJson: text('detected_sigs_json'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});
```

- [ ] **Step 2: Add migration**

At the end of `runMigrations()` in `server/src/db/migrate.ts`, before the closing `}`, add:

```typescript
  const premiumCols = (sqlite.prepare('PRAGMA table_info(premium_analyses)').all() as { name: string }[]).map(r => r.name);
  if (!premiumCols.includes('detected_sigs_json')) {
    sqlite.exec('ALTER TABLE premium_analyses ADD COLUMN detected_sigs_json TEXT');
  }
```

- [ ] **Step 3: Add DetectedSig type + update completePremiumAnalysis**

In `server/src/db/premium.ts`, add the type and update the function:

After the existing `SignalMap` type, add:
```typescript
export interface DetectedSig {
  id: string;
  name: string;
  category: string;
  evidence: { kind: 'network' | 'dom'; value: string };
}
```

Update `completePremiumAnalysis` signature to add `detectedSigs: DetectedSig[]` in the `r` parameter and store it:

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
    errorMessage: r.errorMessage ?? null,
    completedAt: new Date().toISOString(),
  }).where(eq(premiumAnalyses.id, id)).run();
}
```

- [ ] **Step 4: tsc check**

Run `npx tsc --noEmit` from inside Docker container. Expected: TypeScript complains that callers of `completePremiumAnalysis` (in `premiumAnalyzer.ts` and `premiumAnalysisQueue.ts`) are missing `detectedSigs`. That's correct — they'll be fixed in Task 3.

---

## Task 3 — Signature scanner in premiumAnalyzer

**Files:**
- Modify: `server/src/services/premiumAnalyzer.ts`

- [ ] **Step 1: Add imports at top of premiumAnalyzer.ts**

Add after existing imports:
```typescript
import { SIGNATURES, type Signature } from '../data/signatureLibrary';
import type { DetectedSig } from '../db/premium';
```

- [ ] **Step 2: Add scanSignatures function**

Add this function before `runPremiumAnalysis`:

```typescript
function scanSignatures(
  html: string,
  networkUrls: string[],
): { detectedSigs: DetectedSig[]; signalUpgrades: Partial<SignalMap> } {
  const detectedSigs: DetectedSig[] = [];
  const signalUpgrades: Partial<SignalMap> = {};

  for (const sig of SIGNATURES) {
    let evidence: DetectedSig['evidence'] | null = null;

    // Network match is preferred (higher signal, exact URL as evidence)
    if (sig.network) {
      const hit = networkUrls.find(u => sig.network!.test(u));
      if (hit) evidence = { kind: 'network', value: hit };
    }

    // DOM match as fallback
    if (!evidence && sig.dom) {
      const snippet = snippetAround(html, sig.dom);
      if (snippet) evidence = { kind: 'dom', value: snippet };
    }

    if (!evidence) continue;

    detectedSigs.push({ id: sig.id, name: sig.name, category: sig.category, evidence });

    if (sig.signalKey) {
      signalUpgrades[sig.signalKey] = {
        state: 'PRESENT',
        evidence: { kind: evidence.kind, value: evidence.value },
        checkedBy: ['dom', 'network'],
      };
    }
  }

  return { detectedSigs, signalUpgrades };
}
```

- [ ] **Step 3: Wire scanner into runPremiumAnalysis — ok path**

In `runPremiumAnalysis`, replace the existing `ok`-path block (currently lines ~212-220):

**Before:**
```typescript
  const paths = writeBundle(row.businessId, row.id, render);
  const signals = detectSignals(render.html!, render.networkUrls, render.finalUrl!);

  completePremiumAnalysis(row.id, {
    status: 'done', renderOutcome: 'ok', finalUrl: render.finalUrl,
    signals, cookieWall: render.cookieWallDetected, consoleErrors: render.consoleErrors,
    paths,
  });
  broadcast('premium:progress', { businessId: row.businessId, analysisId: row.id, status: 'done', renderOutcome: 'ok' });
```

**After:**
```typescript
  const paths = writeBundle(row.businessId, row.id, render);
  const signals = detectSignals(render.html!, render.networkUrls, render.finalUrl!);
  const { detectedSigs, signalUpgrades } = scanSignatures(render.html!, render.networkUrls);
  // Upgrade UNKNOWN signals where signature scanner found evidence
  for (const [key, upgrade] of Object.entries(signalUpgrades)) {
    if (signals[key]?.state === 'UNKNOWN') signals[key] = upgrade;
  }

  completePremiumAnalysis(row.id, {
    status: 'done', renderOutcome: 'ok', finalUrl: render.finalUrl,
    signals, cookieWall: render.cookieWallDetected, consoleErrors: render.consoleErrors,
    paths, detectedSigs,
  });
  broadcast('premium:progress', { businessId: row.businessId, analysisId: row.id, status: 'done', renderOutcome: 'ok' });
```

- [ ] **Step 4: Wire scanner into runPremiumAnalysis — non-ok path**

The non-ok path (render failed or redirect_social) already calls `completePremiumAnalysis`. Update those calls to pass `detectedSigs: []`.

The `no_website` early return:
```typescript
    completePremiumAnalysis(row.id, {
      status: 'done', renderOutcome: 'no_website', finalUrl: null,
      signals: {}, cookieWall: false, consoleErrors: [], paths: {},
      detectedSigs: [],
    });
```

The non-ok render path (after `allUnknown()`):
```typescript
    completePremiumAnalysis(row.id, {
      status, renderOutcome: render.outcome, finalUrl: render.finalUrl,
      signals, cookieWall: render.cookieWallDetected, consoleErrors: render.consoleErrors,
      paths: {}, errorMessage: render.errorMessage,
      detectedSigs: [],
    });
```

The queue worker catch (in `premiumAnalysisQueue.ts`):
```typescript
      completePremiumAnalysis(row.id, {
        status: 'failed', renderOutcome: 'browser_error', finalUrl: null,
        signals: {}, cookieWall: false, consoleErrors: [], paths: {},
        detectedSigs: [],
        errorMessage: message,
      });
```

- [ ] **Step 5: tsc check**

```bash
npx tsc --noEmit
```
Expected: clean — all callers now pass `detectedSigs`.

---

## Task 4 — Gemini composer: suppress false gaps from detected sigs

**Files:**
- Modify: `server/src/services/geminiComposer.ts`

- [ ] **Step 1: Add DetectedSig import**

At top of `geminiComposer.ts`, add:
```typescript
import type { DetectedSig } from '../db/premium';
```

- [ ] **Step 2: Update buildAnalysisGaps to accept and use detectedSigs**

Change the function signature from:
```typescript
function buildAnalysisGaps(b: BusinessForEmail, a: WebsiteAnalysis): { gaps: string[]; count: number }
```
to:
```typescript
function buildAnalysisGaps(b: BusinessForEmail, a: WebsiteAnalysis, detectedSigs?: DetectedSig[]): { gaps: string[]; count: number }
```

Inside the function, before building `raw`, add helper booleans:
```typescript
  const sigCategories = new Set(detectedSigs?.map(s => s.category) ?? []);
  const sigIds = new Set(detectedSigs?.map(s => s.id) ?? []);
  const hasBookingSig = sigCategories.has('booking');
  const hasWhatsappSig = sigCategories.has('whatsapp');
  const hasChatSig = sigCategories.has('chat');
  const hasFormSig = sigCategories.has('forms');
```

Then update the relevant gap conditions:
- `isBookable && !a.hasOnlineBooking` → add `&& !hasBookingSig`
- `isAR && !a.hasWhatsappLink` in `buildAnalysisContext` → add `&& !hasWhatsappSig`
- `!a.hasWhatsappLink` in `buildAnalysisGaps` → add `&& !hasWhatsappSig`
- `!a.hasContactForm` → add `&& !hasFormSig`

Also update the `existingChatNote` in `composeEmail` to trigger when `analysis?.hasLiveChatWidget || hasChatSig`:
- Currently: `...(analysis?.hasLiveChatWidget ? { existingChatNote: ... } : {})`
- Update to check detectedSigs too (see Step 3).

- [ ] **Step 3: Update buildAnalysisContext similarly**

Change function signature:
```typescript
function buildAnalysisContext(b: BusinessForEmail, a: WebsiteAnalysis, isAR: boolean, detectedSigs?: DetectedSig[]): string
```

Add the same helper booleans inside (copy from Step 2), then apply:
- `isBookable && !a.hasOnlineBooking` → `&& !hasBookingSig`
- `isAR && !a.hasWhatsappLink` → `&& !hasWhatsappSig`
- `!a.hasContactForm` → `&& !hasFormSig`

- [ ] **Step 4: Update composeEmail signature and callsites**

Change `composeEmail` signature to add optional `detectedSigs`:
```typescript
export async function composeEmail(
  business: BusinessForEmail,
  analysis?: WebsiteAnalysis,
  approvedExample?: { subject: string; body: string } | null,
  detectedSigs?: DetectedSig[],
): Promise<{ subject: string; body: string; topGap: string | null }>
```

Inside `composeEmail`, pass `detectedSigs` to `buildAnalysisContext` and `buildAnalysisGaps`:
```typescript
  const analysisContext = analysis?.loadedSuccessfully ? buildAnalysisContext(business, analysis, isArgentina, detectedSigs) : '';
  // ...
  const { gaps, count } = analysis?.loadedSuccessfully
    ? buildAnalysisGaps(business, analysis, detectedSigs)
    : { gaps: [], count: 0 };
```

Also update `existingChatNote` to include sig-detected chat:
```typescript
  const hasChatDetected = analysis?.hasLiveChatWidget || (detectedSigs?.some(s => s.category === 'chat') ?? false);
  userPayload = {
    ...userPayload,
    // ...
    ...(hasChatDetected ? {
      existingChatNote: 'This site already has a live chat widget. ...',
    } : {}),
  };
```

- [ ] **Step 5: tsc check**

```bash
npx tsc --noEmit
```
Expected: clean.

---

## Task 5 — Route updates

**Files:**
- Modify: `server/src/routes/outreachQueue.ts`

- [ ] **Step 1: Update GET /premium/:businessId to include detectedSigs**

In the `GET /premium/:businessId` handler, update the `analysis` object in the response:

```typescript
router.get('/premium/:businessId', (req, res) => {
  const row = getLatestPremiumAnalysis(req.params.businessId);
  if (!row) return res.json({ analysis: null });
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
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    },
  });
});
```

- [ ] **Step 2: Update POST /generate to fetch + pass detectedSigs**

Add import at top:
```typescript
import type { DetectedSig } from '../db/premium';
```

In the `POST /generate` handler, after fetching the business row, add:
```typescript
  const premiumRow = getLatestPremiumAnalysis(businessId);
  const detectedSigs: DetectedSig[] | undefined =
    premiumRow?.detectedSigsJson ? JSON.parse(premiumRow.detectedSigsJson) : undefined;
```

Then update the `composeEmail` call to include `detectedSigs`:
```typescript
    const result = await composeEmail({
      name: row.name,
      category: row.category ?? null,
      website: row.website ?? null,
      locCountry: row.locCountry ?? null,
      locNeighbourhood: row.locNeighbourhood ?? null,
      rating: row.rating ?? null,
      reviewCount: row.reviewCount ?? null,
    }, analysis, undefined, detectedSigs);
```

Note: `approvedExample` is currently not passed by this route (it was undefined before). The explicit `undefined` keeps the existing behavior.

- [ ] **Step 3: tsc check**

```bash
npx tsc --noEmit
```
Expected: clean.

---

## Task 6 — Client API types

**Files:**
- Modify: `client/src/lib/outreachApi.ts`

- [ ] **Step 1: Add DetectedSig interface + update PremiumAnalysis**

After the `TriState` type, add:
```typescript
export interface DetectedSig {
  id: string;
  name: string;
  category: string;
  evidence: { kind: 'network' | 'dom'; value: string };
}
```

Update `PremiumAnalysis` to add `detectedSigs`:
```typescript
export interface PremiumAnalysis {
  id: string;
  businessId: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  renderOutcome: string | null;
  finalUrl: string | null;
  signals: Record<string, PremiumSignal> | null;
  cookieWall: boolean;
  consoleErrors: string[];
  desktopScreenshotPath: string | null;
  mobileScreenshotPath: string | null;
  htmlPath: string | null;
  networkLogPath: string | null;
  detectedSigs: DetectedSig[];
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}
```

- [ ] **Step 2: tsc check (client side)**

```bash
# From client/ directory:
npx tsc --noEmit
```
Expected: TypeScript may flag that consumers of `PremiumAnalysis` need updates (Outreach.tsx). That's expected — fixed in Task 7.

---

## Task 7 — UI: show detected signatures in EmailComposer

**Files:**
- Modify: `client/src/pages/Outreach.tsx`
- Modify: `client/src/components/Outreach/EmailComposer.tsx`

- [ ] **Step 1: Update premium state type in Outreach.tsx**

Change the `premium` state declaration from:
```typescript
const [premium, setPremium] = useState<{ status: string; renderOutcome: string | null } | null>(null);
```
to:
```typescript
const [premium, setPremium] = useState<{
  status: string;
  renderOutcome: string | null;
  detectedSigs?: DetectedSig[];
} | null>(null);
```

Add import:
```typescript
import type { DetectedSig } from '../lib/outreachApi';
```

- [ ] **Step 2: Fetch detectedSigs on lead select and on SSE done**

In `doSelectLead`, the existing call already fetches premium:
```typescript
    getPremiumAnalysis(lead.id).then(a => {
      if (a) setPremium({ status: a.status, renderOutcome: a.renderOutcome });
    }).catch(() => {});
```

Update to also include `detectedSigs`:
```typescript
    getPremiumAnalysis(lead.id).then(a => {
      if (a) setPremium({ status: a.status, renderOutcome: a.renderOutcome, detectedSigs: a.detectedSigs });
    }).catch(() => {});
```

In the SSE handler for `premium:progress`, when status is 'done', fetch the full analysis:
```typescript
    'premium:progress': (data) => {
      const d = data as { businessId?: string; status?: string; renderOutcome?: string | null };
      if (d.businessId && d.businessId === activeLeadRef.current?.id && d.status) {
        if (d.status === 'done') {
          // Fetch full analysis to get detectedSigs
          getPremiumAnalysis(d.businessId).then(a => {
            if (a) setPremium({ status: a.status, renderOutcome: a.renderOutcome, detectedSigs: a.detectedSigs });
          }).catch(() => {
            setPremium({ status: d.status!, renderOutcome: d.renderOutcome ?? null });
          });
        } else {
          setPremium({ status: d.status, renderOutcome: d.renderOutcome ?? null });
        }
      }
    },
```

- [ ] **Step 3: Update EmailComposer props**

In `EmailComposer.tsx`, update the `premium` prop type to include `detectedSigs`:

```typescript
  premium: { status: string; renderOutcome: string | null; detectedSigs?: DetectedSig[] } | null;
```

Add import at top:
```typescript
import type { DetectedSig } from '../../lib/outreachApi';
```

- [ ] **Step 4: Add signature list to EmailComposer**

This renders below the premium scan status chip, only when status=done and detectedSigs.length>0. Add state for expanded evidence item:
```typescript
  const [expandedSig, setExpandedSig] = useState<string | null>(null);
```

After the premium status chip section (around line 584), add:

```tsx
        {/* Detected signatures — shown when premium scan is done */}
        {hasWebsite && !confirmingSend && premium?.status === 'done' && premium.detectedSigs && premium.detectedSigs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
            <div style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--text-muted)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase' as const,
            }}>
              Detected
            </div>
            {(['whatsapp', 'chat', 'booking', 'forms', 'builder', 'analytics'] as const)
              .map(cat => {
                const sigs = premium.detectedSigs!.filter(s => s.category === cat);
                if (sigs.length === 0) return null;
                const catLabel: Record<string, string> = {
                  whatsapp: 'WhatsApp', chat: 'Chat', booking: 'Booking',
                  forms: 'Forms', builder: 'Builder', analytics: 'Analytics',
                };
                return (
                  <div key={cat} style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 4, alignItems: 'flex-start' }}>
                    <span style={{
                      fontFamily: 'var(--font-ui)',
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      minWidth: 54,
                      paddingTop: 3,
                    }}>{catLabel[cat]}</span>
                    <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 4 }}>
                      {sigs.map(sig => (
                        <div key={sig.id}>
                          <button
                            onClick={() => setExpandedSig(expandedSig === sig.id ? null : sig.id)}
                            style={{
                              fontFamily: 'var(--font-ui)',
                              fontSize: 11,
                              padding: '2px 8px',
                              borderRadius: 100,
                              border: '1px solid var(--border-strong)',
                              background: expandedSig === sig.id ? 'var(--accent-dim)' : 'var(--bg-elevated)',
                              color: expandedSig === sig.id ? 'var(--accent)' : 'var(--text-secondary)',
                              cursor: 'pointer',
                            }}
                          >
                            {sig.name}
                          </button>
                          {expandedSig === sig.id && (
                            <div style={{
                              marginTop: 4,
                              padding: '6px 8px',
                              background: 'var(--bg-elevated)',
                              border: '1px solid var(--border)',
                              borderRadius: 6,
                              fontFamily: 'var(--font-mono)',
                              fontSize: 10,
                              color: 'var(--text-muted)',
                              wordBreak: 'break-all' as const,
                              maxWidth: 280,
                            }}>
                              <span style={{ color: 'var(--text-secondary)', fontSize: 9, textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>
                                {sig.evidence.kind}
                              </span>
                              {' '}
                              {sig.evidence.value.length > 120
                                ? sig.evidence.value.slice(0, 120) + '…'
                                : sig.evidence.value}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
```

- [ ] **Step 5: tsc check (client)**

```bash
# From client/ directory:
npx tsc --noEmit
```
Expected: clean.

---

## Task 8 — Full tsc clean + verification gate

**Files:** No new files. Verification only.

- [ ] **Step 1: tsc clean on server**

```bash
# In Docker container:
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 2: tsc clean on client**

```bash
# From client/ directory:
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Find Estudio Juridico DS businessId**

```bash
# In Docker container shell, query the DB:
node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/db.sqlite');
const rows = db.prepare(\"SELECT b.id, b.name FROM businesses b INNER JOIN premium_analyses pa ON pa.business_id = b.id WHERE b.name LIKE '%Juridico%' OR b.name LIKE '%juridico%' OR b.name LIKE '%Jur%' LIMIT 10\").all();
console.log(JSON.stringify(rows, null, 2));
db.close();
"
```

- [ ] **Step 4: Re-run premium analysis on Estudio Juridico DS**

Using the businessId from Step 3, call the API:
```bash
curl -s -X POST http://localhost:3001/api/outreach/premium-analyze \
  -H 'Content-Type: application/json' \
  -d '{"businessId":"<ID_FROM_STEP3>"}'
```
Wait for completion (check SSE or poll):
```bash
curl -s http://localhost:3001/api/outreach/premium/<ID_FROM_STEP3>
```

**Expected:** Response includes `detectedSigs` array with at least one entry where `category === 'whatsapp'` and `evidence.kind` is `'network'` or `'dom'`.

- [ ] **Step 5: Find a chat-widget site**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/db.sqlite');
// Look for businesses whose website analysis or premium signals suggest a chat widget
const rows = db.prepare(\"SELECT DISTINCT b.id, b.name, b.website FROM businesses b INNER JOIN premium_analyses pa ON pa.business_id = b.id WHERE pa.status = 'done' AND pa.signals_json LIKE '%hasLiveChatWidget%' LIMIT 5\").all();
console.log(JSON.stringify(rows, null, 2));
db.close();
"
```

Re-run premium analysis on one of these. **Expected:** `detectedSigs` includes entry with `category === 'chat'` with evidence (tawk-to, crisp, etc.).

- [ ] **Step 6: Find a builder site**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/db.sqlite');
const rows = db.prepare(\"SELECT b.id, b.name, b.website FROM businesses b INNER JOIN premium_analyses pa ON pa.business_id = b.id WHERE pa.status = 'done' AND pa.html_path IS NOT NULL LIMIT 20\").all();
console.log(JSON.stringify(rows, null, 2));
db.close();
"
```

Run premium analysis on a WordPress or Wix site. **Expected:** `detectedSigs` includes entry with `category === 'builder'`.

If no existing leads qualify, pick any public WordPress or Wix site URL and insert a test business:
```bash
node -e "
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const db = new Database('/app/data/db.sqlite');
const id = randomUUID();
db.prepare(\"INSERT INTO businesses (id, job_id, name, website, social_enriched, location_enriched, scraped_at) VALUES (?, 'test', 'Test WordPress Site', 'https://kinsta.com', 0, 0, datetime('now'))\").run(id);
console.log('id:', id);
db.close();
"
```

- [ ] **Step 7: Verify no-widget site → all UNKNOWN, zero ABSENT_VERIFIED**

Run premium analysis on a simple static site (e.g., a business with a plain HTML site, or create a test record pointing to `https://example.com`).

Query result:
```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/db.sqlite');
const row = db.prepare('SELECT signals_json, detected_sigs_json FROM premium_analyses WHERE business_id = ? ORDER BY created_at DESC LIMIT 1').get('<BUSINESS_ID>');
const signals = JSON.parse(row.signals_json || '{}');
const absent = Object.entries(signals).filter(([k, v]) => v.state === 'ABSENT_VERIFIED' && k !== 'hasSSL');
console.log('ABSENT_VERIFIED (non-SSL):', absent.length, absent.map(([k]) => k));
const detected = JSON.parse(row.detected_sigs_json || '[]');
console.log('detectedSigs:', detected.length, detected.map(d => d.id));
db.close();
"
```

**Expected:** `absent.length === 0`. `detectedSigs` has no whatsapp/chat/booking entries (only possibly builder/analytics if those are on the test site).

- [ ] **Step 8: Verify redirect_social → pure UNKNOWN**

Find a business whose website redirects to Facebook or Instagram:
```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/db.sqlite');
const rows = db.prepare(\"SELECT b.id, b.name FROM businesses b INNER JOIN premium_analyses pa ON pa.business_id = b.id WHERE pa.render_outcome = 'redirect_social' LIMIT 3\").all();
console.log(JSON.stringify(rows, null, 2));
db.close();
"
```

Re-run premium analysis on one. **Expected:** `detectedSigs === []`, all signals UNKNOWN (none PRESENT from scanner).

- [ ] **Step 9: Commit**

```bash
git add server/src/data/signatureLibrary.ts \
        server/src/db/schema.ts \
        server/src/db/migrate.ts \
        server/src/db/premium.ts \
        server/src/services/premiumAnalyzer.ts \
        server/src/services/geminiComposer.ts \
        server/src/routes/outreachQueue.ts \
        client/src/lib/outreachApi.ts \
        client/src/components/Outreach/EmailComposer.tsx \
        client/src/pages/Outreach.tsx
git commit -m "feat(premium): Slice 2 — signature scanner + widget inventory"
```
