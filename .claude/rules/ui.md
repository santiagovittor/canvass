---
paths: ["client/src/**"]
---

# UI Rules — maps-scraper client

Before implementing or modifying any UI component, read `@UI_DESIGN_REFERENCE.md` in full. This file is the short enforcement layer; the reference is the source of truth.

## BANNED DEFAULTS

Do not ship any of the following. No exceptions, no "just this once."

- **Fonts:** Inter, Roboto, Arial, `system-ui`, or any generic sans as primary. This project is not a SaaS landing page.
- **Palettes:** purple/violet gradients on white or light backgrounds. Tailwind's `slate-900 + blue-500` default combo. Anything that looks like an untouched `create-react-app` starter.
- **UI libraries:** `shadcn/ui`, Radix, Mantine, Chakra, MUI. All primitives live in `client/src/ui/` and are custom. If a primitive is missing, build it — do not pull in a library.
- **Surfaces:** white cards with `drop-shadow-sm` + `rounded-lg`. This UI is dark. Every surface sits on `--bg-base` or darker.
- **Loading states:** the literal text `Loading...`. Use a custom skeleton, a pulsing accent bar, or a shimmer.
- **Dialogs:** `alert()`, `confirm()`, `prompt()`, or any native browser modal. Use inline component state + toasts.
- **Progress UI:** the native `<progress>` element. Build it with `div`s and CSS, per the aesthetics block below.
- **Data layer:** `axios`, React Query, SWR, tRPC client, Apollo. All HTTP goes through `lib/api.ts` + custom hooks in `hooks/`.
- **Map deps:** do not bump `react-leaflet` or `leaflet`. Pinned to `react-leaflet@4.2.x` and `leaflet@1.9.x`. v5 / v2 break the overlay layer.
- **Realtime:** no polling loops, no `setInterval` fetches, no WebSocket client. Server-Sent Events only, from `/events`.

## REQUIRED AESTHETICS

Read these as hard constraints, not suggestions.

**Typography**
- UI text: `Outfit` (weights 400/500/600).
- All numeric values — counters, coordinates, timers, progress percentages, row counts, lat/lng, IDs: `JetBrains Mono`. No exceptions. A number rendered in Outfit is a bug.

**Color tokens** — defined in `globals.css`, referenced by CSS variable. Use exactly these names and values:

```css
--bg-base:     #0D0F14
--bg-panel:    #161920
--bg-elevated: #1C2028
--accent:      #00E5CC
--accent-glow: rgba(0, 229, 204, 0.4)
--warn:        #F5B700
--error:       #FF4D6D
--success:     #4ADE80
```

Do not introduce new top-level colors. Do not hardcode hex values in components. If a shade is missing, it goes in `globals.css` first.

**Primary buttons**
- Background: `var(--accent)`
- Text: `#071614` (near-black teal — not pure black, not white)
- Hover: retain background, add `box-shadow: 0 0 20px var(--accent-glow)`
- Disabled: 40% opacity, no glow

**Progress bars**
- Track: `var(--bg-elevated)`
- Fill: `var(--accent)` with `box-shadow: 0 0 12px var(--accent-glow)`
- Width is the only dynamic inline style allowed.

**Panels**
- Background: `var(--bg-panel)`
- Border: `1px solid rgba(255, 255, 255, 0.08)`
- Border radius: `12px`
- No drop shadows on panels. Elevation is communicated by the border and `--bg-elevated` for nested surfaces.

**Map**
- Tile layer: CartoDB Dark Matter only (`https://{s}.basemaps.cartocdn.com/dark_all/...`). Do not swap in OSM, Mapbox, Stadia, or a "dark" Google variant.
- Grid overlay cells: dashed teal stroke, `dashArray: "2,3"`, stroke color `var(--accent)`, low-opacity accent fill (~0.04–0.08). Cells must stay legible over the tile layer.

## QUICK CORRECTION PHRASES

Copy-paste these when the output drifts. They are corrections, not conversations.

- **Wrong button color.** → `Buttons use --accent bg with #071614 text, glow on hover. Not blue, not white, not a gradient. Fix it.`
- **Wrong font.** → `Outfit for UI, JetBrains Mono for every number. No Inter, no system-ui, no Roboto. Redo.`
- **Light panels.** → `This UI is dark. --bg-panel (#161920) with rgba(255,255,255,0.08) border, 12px radius. No white cards, no drop-shadow. Redo.`
- **Polling.** → `No polling. No setInterval. Realtime is SSE only at /events. Rewrite the hook.`
- **Wrong leaflet version.** → `leaflet is pinned to 1.9.x, react-leaflet to 4.2.x. Do not upgrade. Roll it back.`

## COMPONENT RULES

- No business logic in components. Components render state and emit events. Logic lives in hooks or `lib/`.
- All data fetching goes through `lib/api.ts` + a custom hook in `hooks/`. A `fetch(` call inside a `.tsx` file is a code smell and almost always wrong.
- No inline `style={}` except for genuinely dynamic values — e.g. `width: ${pct}%` on a progress fill, `transform: translate(...)` on a drag handle. Everything else is Tailwind or `globals.css`.
- Animations: one well-chosen transition beats five scattered ones. Prefer a single deliberate motion (accent glow ramp, grid cell fill-in) over decorating every element with `transition-all`.