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
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.08em"
  mono:
    fontFamily: "JetBrains Mono, SF Mono, monospace"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.4
  mono-display:
    fontFamily: "JetBrains Mono, SF Mono, monospace"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1
rounded:
  sm:   "6px"
  md:   "8px"
  lg:   "12px"
  pill: "100px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "20px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.safelight}"
    textColor: "#1C0E02"
    rounded: "{rounded.md}"
    padding: "10px 18px"
  button-primary-hover:
    backgroundColor: "{colors.safelight}"
    textColor: "#1C0E02"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.contact-print}"
    rounded: "{rounded.md}"
    padding: "10px 18px"
  button-danger:
    backgroundColor: "rgba(255,77,109,0.12)"
    textColor: "{colors.stop-bath}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  panel:
    backgroundColor: "{colors.developer-tray}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
---

# Design System: Maps Scraper

## 1. Overview

**Creative North Star: "The Darkroom"**

This tool is designed around the feeling of working in a darkroom: warm near-black surfaces, a single amber safelight as the only saturated color, and the focused calm of a space built for deliberate, precise work. The warmth is not decorative. It comes from the materials themselves: the dark field is not blue-black or neutral-gray, it tilts faintly toward brown and amber, as if the surfaces have absorbed the light from years of use. The safelight glows where attention belongs.

The aesthetic rejects the twin failure modes of the category: the cold terminal-native dark mode (monospace everywhere, harsh blue-white, blinking cursors) and the clinical data-dashboard (flat gray surfaces, blue accent, enterprise-neutral). This tool should feel like something a person designed, not something an AI generated. The analog texture is earned through color temperature, type rhythm, and the restraint of using warm amber exactly once.

Dense and readable is the operating principle. Data is the product. The interface frames it without celebrating itself.

**Key Characteristics:**
- Warm near-black base: every surface tilts amber, not blue or cool
- Single accent: Safelight (#E8930A) is the only saturated color — it marks active state, interactive affordance, and progress
- Two typefaces: Outfit for all UI text, JetBrains Mono for every number without exception
- Tonal depth through background steps, not shadows
- Glow as semantic signal: the amber glow appears only on active elements and progress fills

## 2. Colors: The Darkroom Palette

One warm near-black, four surface steps, one safelight. Semantics are carried by three separate functional colors that stand apart from the warm register.

### Primary
- **Safelight** (#E8930A): The only saturated color in the system. Used for: active tab indicator, primary button background, progress bar fill, interactive state highlight, outreach status accents. Its presence means "this is happening" or "touch here." Never decorative. Never used more than once per compositional unit.

### Neutral
- **Film Base** (#0F0D0B): The deepest background. Root canvas. Warm near-black with faint amber undertone — not blue-black. Used on `html, body, .leaflet-container`.
- **Developer Tray** (#1A1610): Primary panel background. The surface where most content lives: sidebars, tab strip, panel backgrounds.
- **Print Surface** (#221C14): Elevated surface. Table headers, nested panels, bento cells, select option backgrounds.
- **Lifted Grain** (#2A2218): Hover and interaction layer. Applied via state transitions; never a resting surface.
- **Contact Print** (#EDE8E0): Primary text. Warm off-white (not pure white, not blue-white). All body text, heading text, button labels on dark backgrounds.
- **Silver Halide** (#9A8F7E): Secondary text. Supporting labels, supplementary data, non-critical metadata. 6.4:1 contrast on Film Base.
- **Shadow Detail** (#8A7D70): Muted text. Table headers (uppercase 11px), inactive tab labels, placeholder text, de-emphasized counts. 5.2:1 contrast on Film Base; 4.5:1 on Print Surface — passes WCAG AA throughout.

### Functional
- **Exposure Alert** (#F5B700): Warning state only. Brighter and more yellow than Safelight. Never used as an accent or interactive affordance; reserved for genuine warnings.
- **Stop Bath** (#FF4D6D): Error state only. The sharp cool-red provides maximum visual contrast against the warm palette. Jarring by design.
- **Fix Complete** (#4ADE80): Success state only. Cool green creates a temperature contrast that reads clearly in context.

### Named Rules

**The One Safelight Rule.** #E8930A appears on one element per composition. Its scarcity is the point. If two elements on the same screen both use the accent, one of them is wrong.

**The Warm Canvas Rule.** All backgrounds tilt amber, never blue. `#0F0D0B` not `#0D0F14`. If a neutral feels cold or gray, add warmth (shift toward hue 50–60 in OKLCH). The surface temperature is part of the brand.

**The Warm-Signal Separation Rule.** Safelight (#E8930A) and Exposure Alert (#F5B700) are both amber-family colors and must never appear adjacent or in competing roles. Safelight means "interactive." Alert means "warning." Context is their separator; never co-locate them.

## 3. Typography

**UI Font:** Outfit (weights 400, 500, 600), with `system-ui, sans-serif` fallback.
**Data Font:** JetBrains Mono (weights 500, 600), with `SF Mono, monospace` fallback. Used for every number, coordinate, count, ID, timestamp, and code value without exception.

**Character:** Outfit is a geometric sans with round, approachable forms that read as warm but precise — it does not have the cold clinical edge of Inter or the corporate blandness of Roboto. JetBrains Mono is a developer-grade monospace that keeps tabular numeric data readable at small sizes. The pairing is warm precision: humanist geometry for navigation and labels, engineered clarity for data.

### Hierarchy
- **Display** (Mono 600, 28px, line-height 1): Large stat values in bento cells. Numbers that need to be read at a glance.
- **Title** (Outfit 600, 16–18px, line-height 1.3): Panel headings, section labels. Not used at large scales — this tool has no hero typography.
- **Body** (Outfit 400, 14px, line-height 1.5): Primary body text, table cell content, input text.
- **Label** (Outfit 500, 13px, line-height 1): Tab buttons, button text, medium-weight navigational elements.
- **Caption** (Outfit 500, 11px, letter-spacing 0.08em, uppercase): Table column headers, status pill text, bento cell labels. Uppercase only at this scale and below.

### Named Rules

**The Mono Number Rule.** Every rendered number — coordinate, count, percentage, ID, timestamp, scrape result — uses JetBrains Mono. A number in Outfit is always a bug. The distinction is not stylistic preference; it is a system invariant.

**The No-Display-Heading Rule.** This tool has no hero sections, no display headings, no large-scale typographic moments. The largest deliberate text is 28px mono in bento stat cells. No Outfit above 18px.

## 4. Elevation

This system uses tonal layering, not shadows. Depth is communicated by background color: each nested surface is one step lighter on the warm ramp (Film Base → Developer Tray → Print Surface → Lifted Grain). There are no `box-shadow` values on resting surfaces.

The only intentional "glow" in the system is semantic: the amber safelight glow (`0 0 12px rgba(232, 147, 10, 0.35)`) appears exclusively on two elements — the active progress fill and the primary button hover state. This glow is not elevation; it is a pulse signal indicating live activity or interactivity.

### Named Rules

**The Flat-By-Default Rule.** Panels are flat at rest. No drop shadows on cards, sidebars, or tables. Elevation is a background color step, not a shadow. The ghost-card pattern (1px border + soft wide drop shadow) is explicitly prohibited.

**The Semantic Glow Rule.** The amber glow (`rgba(232, 147, 10, 0.35)`) is a system signal, not a visual style. It means: this element is active or invites interaction. Do not apply it to decorative or static elements.

## 5. Components

### Buttons

Three variants: primary (action), secondary (alternative), danger (destructive). All share 8px radius and Outfit 500/600 text.

- **Primary:** Safelight (#E8930A) background, warm near-black (#1C0E02) text, 10px 18px padding. Hover: amber glow `box-shadow: 0 0 24px rgba(232, 147, 10, 0.35)`. Active: `translateY(1px)`. Disabled: Print Surface bg, Shadow Detail text, no glow.
- **Secondary:** Transparent background, Contact Print text, 1px solid `rgba(255, 245, 235, 0.13)` border. Hover: border shifts to Safelight, background fills with `rgba(232, 147, 10, 0.12)`.
- **Danger:** `rgba(255, 77, 109, 0.12)` tinted background, Stop Bath text, `rgba(255, 77, 109, 0.3)` border.

### Status Pills

Used for job lifecycle states (running, enriching, done, error, pending). Full pill radius (100px), Outfit 500 11px uppercase, 4px 10px padding.

Each variant uses the corresponding semantic color at 12% opacity as background, full-saturation color for text and the 6px dot. The "running" and "enriching" states use Safelight (not a separate color) — job activity is the primary thing the accent marks.

### Panels

12px radius. Developer Tray background with a `linear-gradient(180deg, rgba(255, 245, 235, 0.02) 0%, transparent 100%)` overlay that adds barely-perceptible warm specular top lighting. 1px border at `rgba(255, 245, 235, 0.07)`. 20px padding. No drop shadow.

### Bento Cells (Stat Display)

Print Surface background, 8px radius, 1px border at `rgba(255, 245, 235, 0.07)`, 14px padding. Stack: Caption label (Shadow Detail, uppercase) over Display value (Mono 600 28px, Contact Print). Used for at-a-glance numeric KPIs.

### Progress Bar

6px height, Print Surface track, Safelight fill with semantic glow. Width is the only dynamic inline style. An enriching-state variant pulses the glow with a 1.4s ease-in-out keyframe.

### Tab Strip

40px height, Developer Tray background, bottom border at `rgba(255, 245, 235, 0.07)`. Tab buttons: 13px Outfit 500, Shadow Detail by default, transitions to Safelight with 2px bottom border on active. Hover: Silver Halide. Gap 4px, padding 0 12px per tab.

### Data Table

Sticky headers on Print Surface background, Caption style (11px uppercase, Shadow Detail, 0.08em tracking). Rows on Developer Tray. Border-bottom per row at `rgba(255, 245, 235, 0.07)`. Body text is 13px Outfit 400. Numbers in Mono. Row height approximately 42px.

### Event Log

Film Base background (one step below the parent panel), 1px border, 6px radius, 10px padding. Mono 11px, Shadow Detail text. Fixed max-height with overflow scroll. Terminal-adjacent but warm: background is #0F0D0B, not a blue-tinted black.

## 6. Do's and Don'ts

### Do:
- **Do** tint all neutral backgrounds toward amber (hue 50–60 in OKLCH). The warmth is structural, not decorative.
- **Do** use JetBrains Mono for every number without exception. Set it once per component; don't mix Outfit and Mono within a single data field.
- **Do** let Safelight appear once per composition. Its rarity is the point. More than one amber element per screen dilutes the signal.
- **Do** convey depth through background steps (Film Base → Developer Tray → Print Surface → Lifted Grain). No drop shadows on resting surfaces.
- **Do** verify WCAG AA on Shadow Detail text: it is the minimum contrast color in the system. Check it on every background it appears against.
- **Do** write button labels as verb + object ("Start scrape", "Export CSV", "Send email"). No bare "OK" or "Submit".

### Don't:
- **Don't** use teal, blue, or any cool saturated color as accent or interactive state. The accent is Safelight amber and nothing else. This is a direct anti-reference to "terminal-native" aesthetics (Vercel/Railway/GitHub dark modes).
- **Don't** use white backgrounds, white cards, or light mode surfaces. This tool's identity is its warm near-black canvas. A white panel is a brand failure.
- **Don't** make it feel like a CRM. No badge-heavy status columns with multiple colored indicators fighting for attention, no enterprise-blue table headers, no HubSpot/Salesforce visual density patterns.
- **Don't** make it feel like a 2024 AI SaaS product. No purple or violet. No cream or warm-tinted near-white backgrounds (the "AI beige"). No glassmorphism cards as a default surface. No uppercase eyebrow labels on every section.
- **Don't** use Notion or Linear visual language: no white card grids, no large editorial whitespace, no flat system-ui typography at display sizes.
- **Don't** add a second accent color. Warn (#F5B700), error (#FF4D6D), and success (#4ADE80) are semantic-only and must never carry brand or interactive meaning.
- **Don't** use `border-left` or `border-right` greater than 1px as a decorative stripe on cards or list items.
- **Don't** render numbers in Outfit. Every count, coordinate, percentage, and ID uses JetBrains Mono. This is enforced at the system level, not the component level.
- **Don't** use `border-radius` above 12px on panels or cards. Full-pill (100px) is acceptable for status badges only.
