# Canvass

A self-built prospecting and outreach tool: it maps local businesses, scores them as leads, looks at their websites, and writes cold emails that talk about the specific thing each business is missing. I built it to run my own client acquisition for web and AI assistant work, and I use it most weeks.

> Personal tool, not a product. It mirrors how I actually prospect: pick a neighborhood, find who needs a website or a chatbot, rank them by how good a fit they are, and send something that doesn't read like a template.

---

<!-- SCREENSHOT: hero shot, full app with the map + scrape grid overlay visible -->

---

## What it does, in plain English

Cold outreach usually breaks one of two ways. Mass-send a generic template and everyone ignores it; or hand-write every email and you send four a day. Canvass sits between those: it pulls real business data off Google Maps, figures out which leads are worth my time, reads each one's web presence, and drafts an email grounded in that lead's actual gap so I can review and send instead of writing from a blank page.

It also doesn't stop at "sent." It watches the inbox, catches replies, tells a real human answer apart from an out-of-office bot, tracks opens, and tells me who's gone quiet and is due a follow-up. The whole thing runs in Docker on my machine and streams its state to the UI live, no refresh.

## The pipeline

Five tabs, left to right, in the order I work them.

**Scraper.** Draw a polygon over a map, or type a city or area name and let it tile the region for you. Set a keyword and a grid resolution; the tool splits the area into cells and pulls matching businesses from Google Maps through a self-hosted [gosom](https://github.com/gosom/google-maps-scraper) instance. Progress streams over Server-Sent Events. Jobs are crash-safe: kill the server mid-scrape and it resumes from the last finished cell on boot instead of starting over or dying. gosom itself wedges at random sometimes (a known upstream bug), so the runner watches for a stalled download and restarts the container through the Docker socket to unstick it.

<!-- SCREENSHOT: Scraper tab, polygon drawn over a neighborhood with the grid cells visible -->

**Explorer.** A filterable table of every business scraped. Filter by category, by the country/state/city/neighborhood hierarchy, or by contact status; open a site; mark a lead contacted, replied, or converted. Auto-detected replies get their own styling so a bot answer never gets mistaken for a warm lead.

**Outreach.** This is the core. Leads arrive in a queue ranked by a lead score, not by scrape order, so the best opportunities sit at the top. Two lanes run side by side: businesses that already have a site (pitch a rebuild, a fix, or an AI assistant) and businesses with no site at all (pitch building one). Before I compose, the analyzer visits the lead's website and checks what's really there, then a vision pass screenshots the site and reads its design. Those findings feed the email prompt, so the draft names one concrete gap rather than a vague pitch. Drafts persist, sends are capped per day per sender to protect deliverability, and a follow-up view resurfaces quiet leads after a configurable number of silent days.

<!-- SCREENSHOT: Outreach queue, lead score chips + a drafted email showing a specific anchored gap -->

**Automate.** Scheduled scrapes that recur, and scheduled sends that drip out across the day inside the daily cap instead of firing all at once.

**Analytics.** A KPI strip, a pipeline funnel, a hex-density map of leads, a category-by-zone yield matrix, a send-streak calendar, and insights that surface which categories and neighborhoods actually convert rather than which ones I scraped most.

<!-- SCREENSHOT: Analytics tab, hex-density map or the category-by-zone yield matrix -->

## Lead scoring

Every lead gets a score from 0 to 1 and a letter grade A through D, computed by pure deterministic math so the queue order is stable and I can explain why any given lead ranks where it does. The factors, weighted differently per lane:

- **Rating, shrunk toward the real database mean.** A 5.0 with two reviews shouldn't outrank a 4.6 with four hundred, so the rating is pulled toward the prior with Bayesian shrinkage. That alone killed roughly 720 low-sample 5.0s that used to flood the top of the queue.
- **Establishment**, log-scaled on review count, because a business with 500 reviews is a real operation with money to spend.
- **Category fit.** Legal, dental, medical, and real estate score highest; they have the budget and the clearest fit for booking and assistant automation. Bookable services sit in the middle. Everything else is baseline.
- **Reachability.** On the email lane this keys off whether the address actually verifies; on the no-site lane a phone is the only channel, so it's a hard gate that drops phoneless leads out entirely.
- **Visible pain**, from the site's mobile PageSpeed score plus how many concrete gaps the analysis found. A slow, broken site is a lead with a problem I can name.
- **Advertising intent.** If a site runs a Meta Pixel or Google Ads conversion tag, it gets a boost. A business already paying to acquire customers is the most likely buyer of more marketing and automation. Non-advertisers aren't punished; advertisers are lifted.

The weights are a calibration knob, not gospel. The plan is to retune them against real reply data once enough sends accumulate.

## Reading the website before pitching

Two layers feed the email, and the expensive one is gated so I'm not paying to analyze leads I'll never contact.

The cheap layer crawls the site and checks the basics: SSL, a mobile viewport, a contact form, online booking, a WhatsApp link, the social profiles. It also pulls a Google PageSpeed Insights mobile score.

The expensive layer renders the site in headless Chromium with Playwright, takes a desktop and a mobile screenshot, and sends both to Gemini 2.5 Flash as a vision prompt. The model returns specific, ranked observations: real strengths, concrete opportunities, whether a chat or booking widget is actually visible, whether the layout survives on mobile, roughly what design era the site is from. That vision pass only runs for leads heading into outreach, which is the difference between a Gemini bill of a few cents and a few dollars.

## Writing the email

Composition routes by country. Argentina gets a Spanish prompt in the usted register with a time-of-day greeting and a professional title derived from the category (Dr./Dra. for medical and legal, Arq. for architects, and so on); Spain gets its own Spanish variant; everywhere else gets American English. Each prompt is seeded with a few past emails that landed, picked from a pool bucketed by category, so the model copies a voice that has worked rather than inventing one. The offer adapts to the lead: build from scratch, fix a specific gap, or pitch the AI assistant, never a list of everything at once.

Output runs through a sanitizer that strips em dashes and a few other tells before the draft hits the screen, because nothing says "a robot wrote this" louder than an em dash in a cold email.

## Free model routing and cost tracking

The text stages (compose and verify) default to NVIDIA's NIM free tier, currently Llama 3.3 70B and DeepSeek, with Gemini kept as a paid fallback. The provider seam is a single function the composer and verifier call through, so swapping a model is one string in Settings (`nim:meta/llama-3.3-70b-instruct` versus a Gemini id) with no change to the rate-limiting, retry, timeout, or budget machinery underneath. A model that starts failing gets quarantined and traffic falls back automatically.

Every billed call lands in a durable ledger keyed by stage, model, and lead. Two scripts read it: one rolls spend up by stage, model, day, and priciest leads; the other joins that ledger to the outreach outcome and reports cost-per-sent and cost-per-reply by stage and model, so a cost cut lands with a quality number attached instead of just a smaller bill. Right now the cost-per-reply sample is too thin to trust and the report says so out loud rather than pretending otherwise. The same instrumentation records Gemini's cached-token count, which is how I can see that implicit prompt caching isn't discounting anything yet.

## Protecting deliverability

Every address is verified before it can be sent to: an MX lookup, then an SMTP probe, marking it valid, invalid, or unknown, with an extra distrust pass for providers that accept everything at the door. Bounces come back as DSN messages and flip the address to bounced so it's never tried again. Sends are capped per day per sender, a second Gmail identity rotates in to spread volume, and a suppression list keeps anyone who asked off the list for good.

## Reply detection

The part I'm happiest with. Every ten minutes the server connects to Gmail over IMAP and scans for messages from contacted leads; a match flips the lead to replied and pushes it to the UI over SSE, no refresh.

The trap with inbox matching is that autoresponders look exactly like replies, so each one is classified before it counts, using three signals in order. First, RFC 3834 headers (`Auto-Submitted`, `Precedence: bulk`, `X-Auto-Response-Suppress`); machines usually announce themselves. Second, subject heuristics in English and Spanish ("out of office", "respuesta automática", "fuera de la oficina"). Third, reply velocity: an answer inside three minutes of the send is a machine, because a human reading a cold email doesn't move that fast. Auto-replies stay out of the response rate and keep the lead in the follow-up queue, since an out-of-office isn't engagement; real replies leave the queue immediately so nobody who answered gets pestered. Opens are tracked with a per-send pixel when the app sits behind a public URL.

## Batch processing

For volume, a batch orchestrator walks the whole queue: verify, analyze, compose, in sequence, on one rate-limited Gemini lane so it can't burst past the quota. It runs a watchdog that recovers stuck calls, and when the daily Google request budget is spent it pauses the run and resumes on its own after the quota resets at midnight Pacific instead of dead-lettering every remaining lead. A health banner in the UI shows the Gemini state in three colors before anything actually fails, not after.

A 30-lead batch used to fail hard partway through, and tracking it down took a while. The rate limiter's token bucket had a refill timer that silently stopped re-arming after a settings change, so the single Gemini lane locked up for good once a run crossed roughly one minute's worth of calls; the stall watchdog would then declare the run dead and force-fail everything still in flight. The fix dropped the broken refill logic in favor of plain fixed-interval spacing, made the analyze step something the orchestrator actually waits on instead of abandoning on a timer, and closed a couple of related edge cases where a slow-but-alive run got mistaken for a dead one. Same 30 leads, same rate cap: the run now pushes past 190 calls without a single stall.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express, TypeScript |
| Database | SQLite via better-sqlite3, Drizzle ORM |
| Frontend | React, TypeScript, Vite, Leaflet |
| Scraping | gosom, self-hosted over REST |
| Text AI | NVIDIA NIM free tier (Llama 3.3 70B, DeepSeek), Google Gemini 2.5 Flash fallback |
| Vision AI | Google Gemini 2.5 Flash, screenshots via Playwright |
| Site signals | Google PageSpeed Insights |
| Rate control | Bottleneck plus p-retry, per-minute and per-day budgets |
| Email | Nodemailer over Gmail App Password, imapflow for reply detection |
| Realtime | Server-Sent Events |
| Infra | Docker, Docker Compose |

## Getting started

Runs entirely in Docker. You need a Gemini API key and a Gmail account with an [App Password](https://myaccount.google.com/apppasswords). An NVIDIA NIM key is optional; without it, text generation falls back to Gemini.

```bash
git clone https://github.com/santiagovittor/canvass
cd canvass
cp .env.example .env
# Fill in GEMINI_API_KEY, GMAIL_FROM, GMAIL_APP_PASSWORD, GMAIL_SENDER_NAME
# Optional: NVIDIA_NIM_API_KEY to route text stages to the free tier
docker compose up
```

The app comes up at `http://localhost:3001`. The database and data directory are created on first run, and every environment variable is documented inline in `.env.example`.

## Architecture notes

Clean client/server split with a strict backend layering rule: routes call services, services call the database, and nothing reaches past its layer. No SQL outside the db folder, no fetch inside a component. The AI layer is its own seam so providers swap behind one interface. Grid math runs identically on the client (for the live preview) and the server (for the real job), kept in sync on purpose. Coordinates are stored as strings because SQLite's REAL type loses precision past zoom 17, and that precision is the whole point of a map tool.

The prompt system is tuned to my specific services and market. Pointing it at a different offer means editing the prompt constructors in `geminiComposer.ts`.

## Design

UI built with [Impeccable](https://impeccable.style), a design skill for AI coding tools made to fight generic AI aesthetics. North star: **The Darkroom**. Warm blacks, amber safelight, analog grain, a tool that looks like someone cared how it looked. Built and iterated with [Claude Code](https://claude.ai/code).

---

## En español

Canvass es una herramienta que me armé para conseguir clientes. Hace cuatro cosas: mapea negocios locales sacándolos de Google Maps, los ordena por qué tan buena oportunidad son, mira la web de cada uno, y escribe un mail en frío que habla del problema puntual que ese negocio tiene, no un texto genérico.

La idea es simple. El mail masivo genérico lo ignora todo el mundo; escribir cada mail a mano no escala. Canvass queda en el medio: trae datos reales, decide qué leads valen la pena, lee la presencia web de cada uno, y redacta un borrador apoyado en eso para que yo revise y mande en lugar de escribir desde cero.

Cómo funciona, por pasos:

- **Scraper.** Dibujo un polígono en el mapa o escribo el nombre de una zona, elijo un rubro y la resolución de la grilla, y la app parte el área en celdas y trae los negocios. Si el servidor se cae a mitad del trabajo, retoma desde la última celda terminada al reiniciar.
- **Explorer.** Una tabla filtrable de todo lo scrapeado. Filtro por rubro, por país, provincia, ciudad y barrio, o por estado de contacto.
- **Outreach.** El corazón. Los leads llegan ordenados por un puntaje, así las mejores oportunidades quedan arriba. Hay dos carriles: los que ya tienen web (les ofrezco rehacerla, arreglarla, o un asistente con IA) y los que no tienen (les ofrezco construirla). Antes de escribir, la app revisa la web del negocio y le saca capturas que analiza un modelo de visión, y con eso el borrador habla de un problema concreto.
- **Automate.** Scrapeos programados que se repiten, y envíos que se reparten a lo largo del día sin pasarse del límite diario.
- **Analytics.** Métricas, embudo, un mapa de densidad de leads, y qué rubros y barrios convierten de verdad.

Detalles que me importan: cada dirección de mail se verifica antes de mandarle nada (consulta MX y una prueba SMTP), los rebotes se procesan solos, y hay un tope diario por remitente para cuidar la reputación de envío. Cada diez minutos revisa la casilla por IMAP y detecta respuestas, distinguiendo una respuesta humana real de un contestador automático con tres señales: los encabezados RFC 3834, palabras clave en el asunto en español e inglés, y la velocidad de respuesta (si contesta en menos de tres minutos, es una máquina). Los stages de texto usan modelos gratuitos de NVIDIA NIM, con Gemini como respaldo pago, y cada llamada facturada queda registrada para saber el costo por mail enviado y por respuesta. El borrador pasa por un filtro que saca los guiones largos antes de mostrarse, porque nada grita "lo escribió un robot" más fuerte que un guion largo en un mail en frío.

Todo corre en Docker en mi máquina y actualiza la interfaz en vivo, sin refrescar.

---

*Santiago Vittor · [santiagovittor.store](https://santiagovittor.store) · [LinkedIn](https://www.linkedin.com/in/santiago-vittor/)*
