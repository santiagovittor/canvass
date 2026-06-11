# Canvass

A self-built prospecting and outreach tool for finding local businesses, qualifying them as leads, and sending AI-crafted emails. Built to support my own client acquisition workflow for web and digital services.

> This is a personal tool, not a general-purpose product. It reflects how I actually work: map a neighborhood, identify who needs a website or a chatbot, and reach out with a message that doesn't read like a template.

---

<!-- Screenshots coming soon, UI redesign in progress -->

---

## The problem it solves

Cold outreach at scale is either generic or slow. Generic emails get ignored. Manual personalization doesn't scale. Canvass sits in the middle: it scrapes real business data, evaluates each lead's digital presence, and uses that context to generate emails that are specific without requiring you to write each one from scratch.

It also closes the loop. Most outreach tools stop at "sent." Canvass tracks opens, detects replies by reading the inbox, tells apart a real answer from an out-of-office bot, and surfaces who to follow up with next.

## How it works

Canvass is a four-tab pipeline.

**Scraper.** Draw a polygon over any area on the map, set a keyword and grid resolution, and the tool splits the area into cells and pulls matching businesses from Google Maps through a self-hosted gosom instance. Progress streams live over SSE. Jobs survive crashes: if the server restarts mid-scrape, the job resumes on boot from the last completed cell instead of failing.

**Explorer.** A filterable database of every scraped business. Filter by category, location hierarchy, or contact status; open their website; mark each one as contacted, replied, or converted. Auto-detected replies get their own visual treatment so a bot answer never looks like a warm lead.

**Outreach.** A ranked lead queue. Before composing, a website analyzer visits the lead's site and checks what's actually there: SSL, mobile viewport, contact form, online booking, WhatsApp link. Those findings feed the Gemini prompt, so the email talks about the specific gap that business has rather than a generic pitch. Drafts persist, sends are capped per day to protect deliverability, and a follow-up view resurfaces contacted leads after a configurable number of days of silence.

**Analytics.** KPI strip, pipeline funnel, a hex map of lead density, a category-by-zone yield matrix, a send-streak calendar, and auto-generated insights about which categories and neighborhoods actually convert.

## Reply detection

This is the part I'm most happy with. Every ten minutes the server connects to Gmail over IMAP and scans the inbox for messages from contacted leads. A match flips the lead to "replied" and pushes the update to the UI over SSE, no refresh needed.

The catch with inbox matching is that autoresponders look like replies. Canvass classifies each reply before counting it, using three signals in order:

1. RFC 3834 headers: `Auto-Submitted`, `Precedence: bulk`, `X-Auto-Response-Suppress` and friends. Machines usually confess.
2. Subject heuristics in English and Spanish ("out of office", "respuesta automática", "fuera de la oficina").
3. Reply velocity. An answer that lands within three minutes of the send is a machine; a human reading cold email doesn't move that fast.

Auto-replies are excluded from the response rate, and the lead stays in the follow-up queue, because an out-of-office message is not engagement. Real replies drop out of the queue immediately so nobody who answered gets pestered.

Opens are tracked with a per-send pixel when the app is deployed behind a public URL.

## Enrichment

After every scrape, two enrichment passes run automatically. The first visits each business website and extracts social links (Instagram, Facebook, LinkedIn and others), with hostname resolution and private-IP rejection to keep the crawler from being pointed at internal networks. The second reverse-geocodes coordinates into a country / state / city / neighborhood hierarchy, which is what powers the location filters and the zone analytics.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express, TypeScript |
| Database | SQLite via better-sqlite3, Drizzle ORM |
| Frontend | React, TypeScript, Vite |
| Maps | Leaflet |
| Scraping | gosom (self-hosted, REST) |
| AI | Google Gemini Flash |
| Email | Nodemailer + Gmail App Password, imapflow for reply detection |
| Realtime | Server-Sent Events |
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

The app runs at `http://localhost:3001`. The database and data directory are created automatically on first run. All environment variables are documented with comments in `.env.example`.

## Architecture notes

The project follows a clean client/server split with an explicit layering rule on the backend: routes call services, services call the database. No direct db access from routes. The AI layer lives in `server/src/services/geminiComposer.ts` and uses a multi-prompt system with separate context builders for business profile, offer framing, and tone calibration.

The prompt system is calibrated to my specific services and market. Adapting it to a different context means modifying the prompt constructors in `geminiComposer.ts`.

## Design

UI design system developed with [Impeccable](https://impeccable.style), a design skill for AI coding tools built to fight generic AI aesthetics. North star: **The Darkroom**. Warm blacks, amber safelight, analog grain. A tool that looks like it was made by someone who cares about how things look.

Built and iterated with [Claude Code](https://claude.ai/code).

---

*Santiago Vittor · [santiagovittor.store](https://santiagovittor.store) · [LinkedIn](https://www.linkedin.com/in/santiago-vittor/)*
