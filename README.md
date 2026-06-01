# Canvass

A self-built prospecting and outreach tool for finding local businesses, qualifying them as leads, and sending AI-crafted emails — built to support my own client acquisition workflow for web and digital services.

> This is a personal tool, not a general-purpose product. It reflects how I actually work: map a neighborhood, identify who needs a website or a chatbot, and reach out with a message that doesn't read like a template.

---

<!-- Screenshots coming soon — UI redesign in progress -->

---

## The problem it solves

Cold outreach at scale is either generic or slow. Generic emails get ignored. Manual personalization doesn't scale. Canvass sits in the middle: it scrapes real business data, evaluates each lead's digital presence, and uses that context to generate emails that are specific without requiring you to write each one from scratch.

## How it works

Canvass is a three-tab pipeline.

**Scraper** — Draw a bounding grid over any location on a map. Set a search keyword and resolution, and the tool pulls matching businesses from Google Maps via a self-hosted gosom instance. Results are stored locally in SQLite.

**Explorer** — A filterable database of every scraped business. Filter by category, location, or contact status. Open their website, review their digital presence, and mark each one as contacted, replied, or converted.

**Outreach** — A classification algorithm ranks contacts by lead quality. Select a lead, generate a Gemini-powered email calibrated to that business's context and what they likely need (web presence, CRM, ads, chatbot), review it in the split-pane composer, and send — without leaving the tab. The prompt system adapts over time based on the emails you actually send.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express, TypeScript |
| Database | SQLite via better-sqlite3 |
| Frontend | React, TypeScript, Vite |
| Maps | Leaflet |
| Scraping | gosom (self-hosted) |
| AI | Google Gemini Flash |
| Email | Nodemailer + Gmail App Password |
| Infrastructure | Docker, Docker Compose |

## Getting started

Canvass runs entirely in Docker. You need a Gemini API key and a Gmail account with an [App Password](https://myaccount.google.com/apppasswords) configured.

```bash
git clone https://github.com/santiagovittor/canvass
cd canvass
cp .env.example .env
# Open .env and fill in GEMINI_API_KEY, GMAIL_FROM, GMAIL_APP_PASSWORD, GMAIL_SENDER_NAME
docker compose up
```

The app runs at `http://localhost:3001`. The database and data directory are created automatically on first run. All required environment variables are documented with comments in `.env.example`.

## Architecture notes

The project follows a clean client/server split with an explicit layering rule on the backend: routes call services, services call the database — no direct db access from routes. The AI layer lives in `server/src/services/geminiComposer.ts` and uses a multi-prompt system with separate context builders for business profile, offer framing, and tone calibration.

The prompt system is intentionally calibrated to my specific services and market. Adapting it to a different context means modifying the prompt constructors in `geminiComposer.ts` — the structure is documented inline.

## Design

UI design system developed with [Impeccable](https://impeccable.style) — a design skill for AI coding tools built to fight generic AI aesthetics. North star: **The Darkroom**. Warm blacks, amber safelight, analog grain. A tool that looks like it was made by someone who cares about how things look.

Built and iterated with [Claude Code](https://claude.ai/code).

---

*Santiago Vittor — [santiagovittor.store](https://santiagovittor.store) · [LinkedIn](https://www.linkedin.com/in/santiago-vittor/)*