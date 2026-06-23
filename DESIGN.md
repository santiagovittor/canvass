---

name: Maps Scraper
description: Personal B2B lead generation and outreach pipeline built on Google Maps data.
colors:
safelight:       "#E8930A"
film-base:       "#0F0D0B"
developer-tray:  "#1A1610"
print-surface:   "#221C14"
lifted-grain:    "#2A2218"
contact-print:   "#EDE8E0"
silver-halide:   "#9A8F7E"
shadow-detail:   "#8A7D70"
exposure-alert:  "#F5B700"
stop-bath:       "#FF4D6D"
fix-complete:    "#4ADE80"
typography:
body:
fontFamily: "IBM Plex Sans, system-ui, sans-serif"
fontSize: "16px"
fontWeight: 400
lineHeight: 1.5
label:
fontFamily: "IBM Plex Sans, system-ui, sans-serif"
fontSize: "13px"
fontWeight: 500
letterSpacing: "0.02em"
caption:
fontFamily: "IBM Plex Sans, system-ui, sans-serif"
fontSize: "12px"
fontWeight: 500
letterSpacing: "0.04em"
mono:
fontFamily: "JetBrains Mono, SF Mono, monospace"
fontSize: "14px"
fontWeight: 500
lineHeight: 1.4
mono-display:
fontFamily: "JetBrains Mono, SF Mono, monospace"
fontSize: "30px"
fontWeight: 600
lineHeight: 1
rounded:
sm:   "6px"
md:   "8px"
lg:   "12px"
pane: "14px"
pill: "100px"
spacing:
xs: "6px"
sm: "10px"
md: "16px"
lg: "22px"
xl: "28px"
components:
button-primary:
backgroundColor: "{colors.safelight}"
textColor: "#1C0E02"
rounded: "{rounded.md}"
padding: "11px 18px"
button-primary-hover:
backgroundColor: "{colors.safelight}"
textColor: "#1C0E02"
button-secondary:
backgroundColor: "transparent"
textColor: "{colors.contact-print}"
rounded: "{rounded.md}"
padding: "10px 16px"
button-danger:
backgroundColor: "rgba(255,77,109,0.12)"
textColor: "{colors.stop-bath}"
rounded: "{rounded.md}"
padding: "9px 14px"
panel:
backgroundColor: "{colors.developer-tray}"
rounded: "{rounded.lg}"
padding: "{spacing.lg}"
-----------------------

# Design System: Maps Scraper

## 1. Overview

**Creative North Star: "The Modern Darkroom Console"**

Maps Scraper is a modern dark geospatial operations console with personality. It keeps the original Darkroom idea — warm near-black surfaces, one amber safelight, focused precision — but updates it for a 2026 product UI: more breathing room, more serious type, softer material depth, restrained motion, and map-native spatial layering.

The Darkroom is a metaphor, not a costume. The product must not look sepia, muddy, retro, terminal-native, or like a 90s simulation game. It should feel warm, serious, useful, modern, and alive during scraping/map activity.

The aesthetic rejects the common failure modes of this category: cold terminal dark mode, clinical enterprise dashboard, generic AI SaaS, and crowded CRM. Dense and readable is the operating principle. Data is the product; the interface frames it without burying it.

**Key Characteristics:**

* Warm near-black base: surfaces tilt amber, not blue or neutral gray.
* Single brand/action accent: Safelight (#E8930A) marks action, focus, progress, selection, and live work.
* Two type roles: approved UI sans for interface text, JetBrains Mono for every data number.
* Comfortable controls, dense data: filters/forms breathe; tables/logs stay efficient.
* Depth through warm surface steps, soft shadows, hairlines, and occasional map glass.
* Motion as feedback: subtle animation clarifies state, disclosure, progress, and live scraping.

## 2. Colors: The Darkroom Palette

One warm near-black, four surface steps, one safelight. Semantics are carried by three separate functional colors that stand apart from the warm register.

### Primary

* **Safelight** (#E8930A): The brand/action accent. Used for primary action, active tab, input focus, progress fill, selected map cells, and live scraping activity. It means "touch here," "this is active," or "this is happening." Never decorative.

### Neutral

* **Film Base** (#0F0D0B): Root canvas. Warm near-black with faint amber undertone. Used on `html`, `body`, `.leaflet-container`.
* **Developer Tray** (#1A1610): Primary panel background: sidebars, tab strips, main panels.
* **Print Surface** (#221C14): Nested/elevated surface: table headers, bento cells, select options, compact rows.
* **Lifted Grain** (#2A2218): Hover and interaction layer; rarely a resting surface.
* **Contact Print** (#EDE8E0): Primary text. Warm off-white, not pure white.
* **Silver Halide** (#9A8F7E): Secondary text and non-critical metadata.
* **Shadow Detail** (#8A7D70): Muted text, placeholders, inactive labels, table headers.

### Functional

* **Exposure Alert** (#F5B700): Warning state only. Never a brand accent.
* **Stop Bath** (#FF4D6D): Error/destructive state only.
* **Fix Complete** (#4ADE80): Success/completion state only.

### Utility Palette

A restrained utility palette may be added in `globals.css` for map overlays, chart series, tags, and semantic distinction. Utility colors must be muted, subordinate, and never replace Safelight for primary actions, active nav, focus, or progress.

### Named Rules

**The Safelight Role Rule.** #E8930A marks action, focus, progress, selection, and live work. Amber everywhere is noise.

**The Accent Budget Rule.** A composition may contain multiple amber signals only when they serve different roles: one primary action, one active nav state, one progress/live indicator. Decorative amber repetition is wrong.

**The Warm Canvas Rule.** All backgrounds tilt amber, never blue. `#0F0D0B` not `#0D0F14`. If a neutral feels cold or gray, warm it.

**The Warm-Signal Separation Rule.** Safelight means interactive/live. Exposure Alert means warning. Do not let them compete.

## 3. Typography

**UI Font:** IBM Plex Sans, weights 400/500/600.
**Approved Alternate:** Outfit may be used if a softer, rounder character is preferred.
**Accessibility Trial:** Atkinson Hyperlegible may be used if legibility becomes the priority.
**Data Font:** JetBrains Mono, weights 500/600, for every numeric/data value.

Inter, Roboto, Arial, and raw `system-ui` are banned as primary design choices. They may exist only as fallbacks.

> **Amendment (slice 0016, 2026-06-23).** The UI face was promoted from Outfit
> to **IBM Plex Sans**, the previously-approved "serious trial." Rationale: the
> BRIEF flagged the interface as reading small and "a bit unserious" (symptoms
> 2–3). The operator chose the serious trial over merely enlarging Outfit, so
> IBM Plex Sans is now the active default and Outfit is demoted to an approved
> alternate. This is a deliberate, signed-off loosening of the prior default —
> not a silent override. The Mono Number Rule and No-Tiny-UI Rule below are
> unchanged: every data number stays in JetBrains Mono, and the larger scale is
> achieved by raising sizes, never by shrinking text.

### Hierarchy

* **Workspace Title** (UI 600, 20–22px, line-height 1.2): App/workspace orientation. Serious, not marketing.
* **Section Title** (UI 600, 17–18px, line-height 1.3): Panel headings and major sections.
* **Body / Input / Table Cell** (UI 400/500, 15–16px, line-height ~1.5): Default readable interface text.
* **Label / Button / Tab** (UI 500/600, 13–14px): Controls and navigation.
* **Caption / Metadata** (UI 500, 12–13px, moderate tracking): Table headers, helper labels, subtle metadata.
* **Mono Data** (JetBrains Mono 500, 13–15px): Coordinates, counts, IDs, timestamps, row counts.
* **Display Number** (JetBrains Mono 600, 28–32px): Large stat values.

### Named Rules

**The Mono Number Rule.** Every rendered data number — coordinate, count, percentage, ID, timestamp, scrape result, timer, price, row count — uses JetBrains Mono. A data number in the UI font is a bug.

**The No-Hero Rule.** This tool has no landing-page hero typography. Operational titles up to 22px are allowed when they improve hierarchy; oversized editorial display type is not.

**The No-Tiny-UI Rule.** Do not solve layout pressure with 10–11px text. First improve grouping, disclosure, spacing, and hierarchy.

**The Caption Restraint Rule.** Uppercase captions are for metadata and table structure, not every section. Do not cover the UI in tiny eyebrow labels.

## 4. Density, Spacing, and Elevation

The product uses **comfortable controls, dense data**.

### Density Modes

* **Comfortable:** Filters, forms, panel headers, empty states, primary actions, map toolbars, inspectors.
* **Compact:** Result rows, tables, side-rail summaries, repeated data.
* **Telemetry:** Logs, coordinates, IDs, event streams, machine output.

Compact does not mean cramped. It means efficient rhythm with maintained legibility.

### Spacing Guidance

* Panel padding: 20–24px.
* Dense panel padding: 14–18px.
* Control height: 36–42px.
* Compact row height: 42–48px.
* Comfortable row height: 48–56px.
* Section gap: 18–28px.
* Inline control gap: 8–12px.
* Filter group gap: 12–16px.

### Elevation

Depth is primarily tonal: Film Base → Developer Tray → Print Surface → Lifted Grain. Root canvas and resting panels stay calm. Modern layering is allowed for genuinely raised or floating surfaces.

**Elevation tokens in `globals.css`:**

* `--shadow-sm` / `--shadow-md` / `--shadow-lg`: warm near-black shadows for raised/floating surfaces only.
* `--surface-highlight`: subtle warm specular top-edge, paired with shadow.
* `--hairline`: translucent light seam for softened chrome.
* `--radius-pane` (14px): raised pane radius.

Allowed raised surfaces: inspectors, floating map controls, popovers, menus, action strips, command bars, drawers, and active scrape status surfaces.

### Named Rules

**The Flat-Root Rule.** Resting panels are flat: background ramp, border/hairline, no drop shadow.

**The Depth-or-Outline Rule.** On one element, choose depth or visible outline. Do not combine heavy border + wide shadow. A hairline seam or semantic warn/error border may coexist with depth.

**No Nested Depth.** Children of raised surfaces stay flat.

**The Semantic Glow Rule.** Amber glow is for live activity/interactivity: progress, focus, selected map cells, primary action hover. It is not generic elevation.

## 5. Motion

Motion is allowed when it clarifies state, continuity, or live activity.

### Approved Motion

* Disclosure open/close.
* Filter chip enter/exit.
* Row reveal/removal.
* Progress shimmer.
* Scraping pulse.
* Map cell selection feedback.
* Panel/drawer entrance.
* Focus/hover glow ramp.
* Toast entrance/exit.
* Skeleton shimmer.

### Timing

* Micro interactions: 120–180ms.
* Disclosure/panel movement: 160–240ms.
* Live shimmer/pulse: 1.2–1.8s.

### Rules

* Do not animate everything.
* Avoid default `transition-all`.
* Prefer opacity, transform, background, shadow, height/grid-template transitions.
* Ambient looping motion is allowed only for live activity.
* Respect `prefers-reduced-motion`.

## 6. Components

### Buttons

Three variants: primary, secondary, danger. All use 8px radius and UI 500/600 text.

* **Primary:** Safelight background, `#1C0E02` text, 10–12px by 16–20px padding. Hover: amber glow. Active: subtle `translateY(1px)`. Disabled: 40% opacity, no glow.
* **Secondary:** Transparent or subtle dark surface, Contact Print text, hairline/border. Hover: Lifted Grain or Accent Dim.
* **Danger:** Low-alpha Stop Bath background, Stop Bath text, low-alpha Stop Bath border.

Button labels should be verb + object: "Start scrape", "Export CSV", "Send email". Avoid bare "OK" or "Submit".

### Status Pills

Used for job lifecycle states. Full pill radius, UI 500, 12px preferred. Each variant may use semantic tint + text + optional dot. Running/enriching may use Safelight because live job activity is a Safelight role. Avoid badge soup.

### Panels

Resting panels: Developer Tray background, 12px radius, `--border`, 20–24px padding, no drop shadow. A subtle top-light gradient is allowed if it improves material quality.

### Raised Panes

Raised panes are allowed for inspectors, floating map panels, action strips, popovers, drawers, and command bars. Use warm shadow, optional surface highlight, radius up to `--radius-pane`. Do not use decorative amber borders.

### Bento Cells

Print Surface background, 8–12px radius, subtle border/hairline, 14–16px padding. Caption label over JetBrains Mono display value. Used for at-a-glance numeric KPIs.

### Progress Bar

6–8px height. Track: Print Surface or BG Elevated. Fill: Safelight with semantic glow. Width is the only dynamic inline style. Running/enriching variants may pulse or shimmer.

### Tab Strip

13–14px UI labels. Active tab uses Safelight text or bottom indicator. Inactive tabs use Shadow Detail/Silver Halide. Avoid tiny 11px navigation.

### Data Table

Sticky headers on Print Surface. Headers use 12px caption style. Body uses 14–16px depending on density. Numbers use JetBrains Mono. Row height 42–52px. Use hover and seams to aid scanning; avoid excessive borders.

### Event Log

Film Base background, hairline/border, 6–8px radius, Mono 11–13px. Terminal-adjacent but warm, never blue-black hacker UI.

### Filters and Disclosure

Primary filters stay visible: search, mode pills, primary segment controls, active summaries.

Secondary filters move behind progressive disclosure when crowded. For Outreach: keep search + mode pills visible, move email/country/website filters behind "Filtros", show active-count badge, preserve all filtering behavior.

A custom `Disclosure` primitive is allowed in `client/src/ui/`: accessible button semantics, clear open state, subtle open/close animation, active-count badge support.

## 7. Map

Tile layer: CartoDB Dark Matter only:

`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`

Do not swap in OSM, Mapbox, Stadia, Google, or any other provider.

Grid overlay cells: dashed amber stroke, `dashArray: "2,3"`, stroke color `var(--accent)`, low-opacity accent fill (~0.04–0.08). Cells must stay legible over the tile layer.

Map controls may use restrained glass: translucent warm dark surface, subtle blur only if performant, hairline edge, warm shadow, restrained amber active state. Do not cover the map with heavy opaque brown boxes unless they are true inspectors.

## 8. Do's and Don'ts

### Do:

* Do make it feel like a modern dark geospatial operations console with personality.
* Do keep the Darkroom warmth without making the UI retro or muddy.
* Do use IBM Plex Sans by default; Outfit is an approved alternate for a softer character.
* Do use JetBrains Mono for every numeric/data value.
* Do use larger, more legible type than the old baseline.
* Do give filters, forms, headers, and primary actions breathing room.
* Do keep data tables/results dense but readable.
* Do use progressive disclosure for secondary filters.
* Do use subtle motion for state, progress, and live scraping.
* Do use soft depth for floating controls, inspectors, and action strips.
* Do define missing tokens in `globals.css` before component use.
* Do build missing primitives in `client/src/ui/`.

### Don't:

* Don't make it feel like a 90s simulation game, terminal skin, CRM, or generic AI SaaS.
* Don't use Inter, Roboto, Arial, or raw system-ui as the primary face.
* Don't use blue, purple, violet, or rainbow accents as brand/action color.
* Don't use white cards, white panels, or light-mode shells.
* Don't shrink UI to 10–11px to fit more controls.
* Don't put uppercase eyebrow labels on everything.
* Don't decorate every element with amber borders/glows.
* Don't use glassmorphism as a default surface.
* Don't add heavy shadows to resting panels.
* Don't render data numbers in the UI font.
* Don't use native `alert`, `confirm`, `prompt`, or `<progress>`.
* Don't add UI libraries for primitives.
* Don't add polling or WebSocket clients; use SSE from `/events`.

## 9. Agent Notes

When improving UI:

1. Read this file and `.claude/rules/ui.md`.
2. Update `globals.css` tokens before component styling.
3. Preserve identity, but prioritize rendered quality over literal rule-following.
4. Use before/after screenshots. If it still looks cramped, retro, tiny, or brown-heavy, fix hierarchy, spacing, type, and surfaces before adding decoration.
