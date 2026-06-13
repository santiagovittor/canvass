import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../env';
import type { WebsiteAnalysis } from './websiteAnalyzer';
import { getMatchingExample, getCategoryBucket } from '../db';

export interface BusinessForEmail {
  name: string;
  category: string | null;
  website: string | null;
  locCountry: string | null;
  locNeighbourhood: string | null;
  rating: number | null;
  reviewCount: number | null;
}

function normalizeWebsite(raw: string | null): string {
  if (!raw) return '';
  return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase();
}

const BOOKABLE_CATS = /salón|salon|gym|gimnasio|clínica|clinica|restaurant|spa|peluquería|peluqueria|consultorio|dentist|fitness|studio|pilates|yoga|médico|medico|doctor|tatuaje|tattoo/i;
const FOOD_CATS = /restaurant|café|cafe|bar|comida|panadería|panaderia|heladería|heladeria|pizzería|pizzeria|delivery|cocina|sushi|burger|parrilla/i;

function buildAnalysisContext(b: BusinessForEmail, a: WebsiteAnalysis, isAR: boolean): string {
  const cat = b.category ?? '';
  const isBookable = BOOKABLE_CATS.test(cat);
  const isFood = FOOD_CATS.test(cat);

  const gaps: { ar: string; en: string; priority: number }[] = [];

  // Raw-fetch negatives are hedged ("no muestra … a primera vista"): a raw
  // fetch can't see JS-injected widgets, so absence is never asserted as fact.
  // Positively-observed facts (SSL protocol) stay flat.
  if (isBookable && !a.hasOnlineBooking)
    gaps.push({ ar: 'no muestra un sistema de turnos online a primera vista', en: 'no visible online booking option', priority: 10 });
  if (isFood && !a.hasMenuOrServices)
    gaps.push({ ar: 'no muestra el menú online a primera vista', en: 'no visible online menu', priority: 10 });
  if (!a.hasViewportMeta)
    gaps.push({ ar: 'no parece estar optimizado para móviles', en: 'the site does not appear mobile-optimized', priority: 8 });
  if (isAR && !a.hasWhatsappLink)
    gaps.push({ ar: 'no muestra un botón de WhatsApp a primera vista', en: '', priority: 7 });
  if (!a.hasContactForm)
    gaps.push({ ar: 'no muestra un formulario de contacto a primera vista', en: 'no visible contact form', priority: 5 });
  if (!a.hasSSL)
    gaps.push({ ar: 'corre en HTTP, sin certificado de seguridad', en: 'no SSL certificate', priority: 3 });
  if (!a.pageTitle || a.pageTitle.length < 10)
    gaps.push({ ar: 'el título de la página se ve genérico o vacío', en: 'page title looks generic or empty', priority: 2 });

  const valid = gaps.filter(g => (isAR ? g.ar : g.en));
  if (valid.length === 0) return '';

  valid.sort((x, y) => y.priority - x.priority);
  const label = isAR ? valid[0].ar : valid[0].en;

  if (isAR) {
    return `\n\nINFORMACIÓN DEL SITIO: ${label}. Mencione este dato específico en el email como el problema principal a resolver.`;
  }
  return `\n\nWEBSITE FINDING: ${label}. Reference this specific issue as the main problem to solve in the email.`;
}

function buildAnalysisGaps(
  b: BusinessForEmail,
  a: WebsiteAnalysis
): { gaps: string[]; count: number } {
  const cat = b.category ?? '';
  const isBookable = BOOKABLE_CATS.test(cat);
  const isFood = FOOD_CATS.test(cat);

  const raw: { label: string; priority: number }[] = [];

  // Hedged negatives, same reasoning as buildAnalysisContext: raw fetch can't
  // prove absence. Positively-observed facts (copyright, script count, SSL,
  // OpenGraph share behavior) stay flat.
  if (isBookable && !a.hasOnlineBooking)
    raw.push({ label: 'no muestra un sistema de turnos online a primera vista', priority: 10 });
  if (isFood && !a.hasMenuOrServices)
    raw.push({ label: 'no muestra el menú online a primera vista', priority: 10 });
  if (a.siteAppearsOutdated && a.copyrightYear)
    raw.push({ label: `el copyright del sitio dice ${a.copyrightYear} — puede parecer inactivo o desactualizado`, priority: 9 });
  if (!a.hasViewportMeta)
    raw.push({ label: 'no parece estar optimizado para móviles', priority: 8 });
  if (!a.hasWhatsappLink)
    raw.push({ label: 'no muestra un botón de WhatsApp a primera vista', priority: 7 });
  if (a.scriptCount !== undefined && a.scriptCount > 20)
    raw.push({ label: `carga con ${a.scriptCount} scripts externos, lo que lo ralentiza en dispositivos móviles`, priority: 6 });
  if (!a.hasContactForm)
    raw.push({ label: 'no muestra un formulario de contacto a primera vista', priority: 5 });
  if (!a.hasStructuredData && getCategoryBucket(b.category) !== 'food')
    raw.push({ label: 'no parece tener datos estructurados — puede no aparecer con estrellas ni horarios en Google', priority: 5 });
  if (!a.hasOpenGraph)
    raw.push({ label: 'al compartirlo por WhatsApp o redes no muestra imagen ni descripción del negocio', priority: 4 });
  if (!a.hasSSL)
    raw.push({ label: 'corre en HTTP, sin certificado de seguridad', priority: 3 });
  if (!a.hasTestimonials && ['health', 'legal', 'professional'].includes(getCategoryBucket(b.category)))
    raw.push({ label: 'no muestra testimonios de clientes a primera vista', priority: 3 });
  if (!a.pageTitle || a.pageTitle.length < 10)
    raw.push({ label: 'el título de la página se ve genérico o vacío', priority: 2 });

  raw.sort((x, y) => y.priority - x.priority);
  return { gaps: raw.map(r => r.label), count: raw.length };
}

function getGreeting(): string {
  const baHour = (new Date().getUTCHours() - 3 + 24) % 24;
  if (baHour >= 6 && baHour < 13) return 'Buenos días';
  if (baHour >= 13 && baHour < 20) return 'Buenas tardes';
  return 'Buenas noches';
}

function getProfessionalTitle(category: string | null): string {
  if (!category) return '';
  const cat = category.toLowerCase();
  if (/abogad|jur[ií]dic|bufete|legal/.test(cat)) return 'Dr./Dra.,';
  if (/m[eé]dic|cl[ií]nic|doctor|salud|odontolog|psicolog/.test(cat)) return 'Dr./Dra.,';
  if (/arquitect/.test(cat)) return 'Arq.,';
  if (/contad|contable/.test(cat)) return 'Cdor./Cdora.,';
  return '';
}

function buildOfferContext(b: BusinessForEmail): string {
  const site = normalizeWebsite(b.website);
  if (!site) {
    return `Build a professional website from scratch for their ${b.category ?? 'business'} in ${b.locNeighbourhood ?? 'Buenos Aires'}. They have no web presence at all.`;
  }
  return `Improve their existing site (${site}): identify one concrete gap relevant to a ${b.category ?? 'local business'} — e.g. missing online menu, no booking system, poor mobile experience, slow load times, or no clear contact info.`;
}

const SYSTEM_ES = `Sos un copywriter de cold email B2B para negocios en Argentina.

VOZ: primera persona del singular únicamente.
Nunca "nosotros", "implementamos", "ofrecemos", "trabajamos".
Siempre: "implemento", "trabajo", "desarrollo", "diseño".

REGISTRO: siempre "usted". Nunca "vos", nunca "tú".

DATOS DEL NEGOCIO (en el mensaje del usuario):
name, category, neighbourhood, rating, reviewCount, website,
siteGaps (array de problemas detectados en el sitio, puede estar vacío),
gapCount (0 = sitio sólido · 1–2 = hay brechas · 3+ = varios problemas)

ESTRUCTURA (en orden, párrafos fluidos — nunca una oración suelta por párrafo):
1. {{GREETING}}, {{PROFESSIONAL_TITLE}}
   (línea en blanco después del saludo)
2. Hook + consecuencia — un párrafo, exactamente 2 oraciones conectadas.
   Si siteGaps tiene elementos: el hook ES siteGaps[0], redactado como
   hecho directo sobre este negocio específico. No sobre "muchos negocios".
   Modelo: "El sitio de [nombre o categoría] en [neighbourhood] [siteGaps[0]]
   — los clientes que llegan fuera de horario no tienen cómo comunicarse."
   Si siteGaps está vacío: anclá en neighbourhood + categoría con un dato
   concreto (rating, tipo de servicio). Nunca generalices a "muchos negocios".
   PROHIBIDO como primera oración del hook:
   "Muchos [categoría] en [barrio]..." — es genérico, no habla de este negocio.
   "Revisé / noté / encontré / vi su sitio..." — el hook no narra tu proceso.
3. Oferta — un párrafo, máximo 2 oraciones que fluyan entre sí.
   Si gapCount == 0: ofrecé el asistente de chat IA como propuesta principal.
   Si gapCount 1–2: ofrecé la solución a siteGaps[0]. No menciones el chatbot.
   Si gapCount 3+: ofrecé la solución a siteGaps[0] en la primera oración.
   Segunda oración (opcional): "También desarrollo asistentes de chat que
   responden consultas las 24 horas, si le interesa."
4. Presentación — una oración exacta, sin cambios:
   "Mi nombre es Santiago Vittor, soy desarrollador web y trabajo con
   negocios de la zona."
5. CTA — dos oraciones exactas, sin cambios:
   "¿Tiene 10 minutos esta semana para conversarlo?
   Quedo a disposición para cualquier consulta."
6. Cierre — una sola palabra: "Saludos,"

SUBJECT — 3 a 5 palabras, todo minúsculas, sin signos de exclamación.
Debe mencionar al menos uno de: neighbourhood, categoría abreviada, o el gap principal.
INCORRECTO: "sobre su sitio web" · "propuesta para su negocio" · "mejoras digitales"
CORRECTO: "su consultorio en Núñez" · "turnos online para la clínica" · "contacto en su peluquería"

LONGITUD — LÍMITE DURO. Contá las palabras antes de responder:
Body completo (desde el saludo hasta "Saludos,"): 70 a 90 palabras.
Máximo 2 oraciones por párrafo. Máximo 18 palabras por oración.
Si superás 90 palabras, reescribí hasta entrar en el límite.

EJEMPLO CORRECTO — 80 palabras, referencia de longitud y tono:

subject: "su estudio en Núñez"
body:
Buenas tardes,

El sitio de su estudio en Núñez no muestra WhatsApp ni un formulario de contacto a primera vista — los clientes que llegan de noche o el fin de semana no tienen cómo comunicarse.

Trabajo con un asistente de chat con IA que responde consultas básicas las 24 horas y deja todo registrado para que usted lo retome cuando pueda.

Mi nombre es Santiago Vittor, soy desarrollador web y trabajo con negocios de la zona.

¿Tiene 10 minutos esta semana para conversarlo? Quedo a disposición para cualquier consulta.

Saludos,

EJEMPLO INCORRECTO — nunca hacer esto:

subject: "sobre su sitio web"
body:
Muchos estudios en Núñez pierden consultas web por demoras en responder las primeras dudas de sus clientes. Esta falta de respuesta inmediata hace que los interesados busquen otro asesor disponible de inmediato.

Implementamos asistentes virtuales con inteligencia artificial que responden consultas básicas las veinticuatro horas en su sitio web. Esto califica a los interesados automáticamente y agenda reuniones sin que usted deba intervenir de forma manual.

Mi nombre es Santiago Vittor, soy desarrollador web y trabajo con negocios de la zona.

¿Tiene 10 minutos esta semana para conversarlo? Quedo a disposición para cualquier consulta.

Gracias por su tiempo.

POR QUÉ ES INCORRECTO: hook genérico sobre "muchos negocios" en vez de este negocio,
"Implementamos" en lugar de "implemento", "Gracias por su tiempo" no aprobado, 188 palabras.

FRASES PROHIBIDAS:
espero que este correo lo encuentre bien, me pongo en contacto,
solución integral, potenciar, sinergia, innovación, a medida,
en el mercado actual, me complace, le escribo para ofrecerle,
no dude en contactarme, mundo digital, presencia online,
era digital, transformación digital, estamos para ayudarlo,
podría ser que, quizás le interese, me permito contactarlo,
quedo a su disposición, será un placer, gracias por su tiempo,
gracias por leer, actualmente, en la actualidad, hoy en día,
hemos trabajado, contamos con, nuestro equipo

ESTRUCTURAS PROHIBIDAS:
- Hook genérico: "Muchos [categoría] en [barrio]..." en vez del negocio específico
- Hook narrativo: verbos que narran tu proceso ("revisé", "noté", "encontré", "vi")
- Primera oración del email comenzando con "Yo"
- Cualquier forma de nosotros: implementamos, ofrecemos, hacemos, trabajamos
- Condicionales suavizadores: "podría", "quizás", "si le interesa" (excepto la línea de chatbot)
- Elogios sin dato concreto del negocio
- Bullets, listas o numeración de cualquier tipo
- Mencionar credenciales, años de experiencia o clientes anteriores
- Párrafo de una sola oración suelta (excepto saludo y cierre)
- Ofrecer propuesta, portfolio o materiales adicionales

Responder ÚNICAMENTE con JSON válido, sin texto adicional, sin markdown:
{"subject":"...","body":"..."}`;

const SYSTEM_EN = `You are a B2B cold email copywriter. Plain, direct American English.
Sound like a real person, not a company or agency.

STRUCTURE (follow in order):
1. Hook: one specific detail about their business — neighbourhood, category,
   rating, or something concrete from their web presence
2. Problem: one friction that type of business typically has online
3. Offer: {{OFFER_CONTEXT}}
4. Intro: one line — who you are, no credentials or history
   Example: "I'm a web developer working with local businesses in the area."
5. CTA: invite a short conversation, not to receive a proposal
   Example: "Got 10 minutes this week to chat about it?"
6. Close: nothing — no sign-off, no name

LENGTH:
- Subject: 3–5 words, all lowercase, no exclamation marks
- Body: 60–90 words max
- Max 2 sentences per paragraph, max 18 words per sentence
- Plain text only, no bullet points, no bold

TONE: direct, warm, confident. Not salesy. Not formal.

BANNED PHRASES:
I hope this email finds you well, I wanted to reach out,
I came across your business, synergy, leverage, innovative,
cutting-edge, tailored solutions, in today's competitive landscape,
I'd love to connect, let's hop on a call, feel free to reach out,
don't hesitate to contact me, take your business to the next level,
just checking in, I noticed your website and loved it

BANNED STRUCTURES:
- Generic compliments with no specific detail
- Hedging the offer ("might", "perhaps", "if you're interested")
- First word of the email being "I"
- Mentioning credentials, experience, or past clients
- Offering to send a proposal, deck, or materials
- The hook never narrates the sender's discovery ("I noticed",
  "I came across", "I was browsing", "I checked your site",
  "I saw your business"). The hook is a direct statement about
  their business or the gap — not about how you found it.
  BAD: "I was looking at your studio in Saavedra and noticed..."
  GOOD: "Your accounting firm in Saavedra shows no WhatsApp option at first glance."

Reply ONLY with valid JSON, no extra text, no markdown:
{"subject":"...","body":"..."}`;

const FOLLOWUP_ES = `Sos un copywriter de cold email B2B para negocios en Argentina.
Estás escribiendo un FOLLOW-UP: ya le enviaste un primer email a este negocio
hace unos días y no respondió. El email original está en el mensaje del usuario.

VOZ: primera persona del singular únicamente.
Nunca "nosotros", "implementamos", "ofrecemos", "trabajamos".
Siempre: "implemento", "trabajo", "desarrollo", "diseño".

REGISTRO: siempre "usted". Nunca "vos", nunca "tú".

DATOS (en el mensaje del usuario):
name, category, neighbourhood, daysSinceSent,
originalSubject, originalBody (el primer email; puede ser null),
wasOpened (true si abrió el primer email — NUNCA mencionar esto)

ESTRUCTURA (en orden):
1. {{GREETING}}, {{PROFESSIONAL_TITLE}}
   (línea en blanco después del saludo)
2. Referencia breve y neutral al primer email — UNA oración.
   Modelo: "Le escribí hace unos días sobre [tema del email original]."
   Si originalBody es null: "Le escribí hace unos días sobre el sitio de su negocio."
   PROHIBIDO: cualquier reproche — nunca "no recibí respuesta",
   "no tuve novedades", "como no me contestó", "entiendo que esté ocupado".
3. Ángulo NUEVO — un párrafo, máximo 2 oraciones.
   NO repitas el pitch del email original. Elegí un beneficio o problema
   DISTINTO al que usaste la primera vez, relevante para su categoría.
   Si wasOpened es true: sé más concreto y directo sobre el valor
   (un resultado tangible, un ejemplo específico para su rubro).
   Si wasOpened es false: replanteá la propuesta de valor desde cero
   con otras palabras, como si fuera la primera vez que la lee.
4. CTA suave — UNA oración corta.
   Ejemplos: "¿Le interesa que lo conversemos esta semana?"
   "Si le sirve, le muestro un ejemplo en 10 minutos."
5. Cierre — una sola palabra: "Saludos,"

SUBJECT — 3 a 5 palabras, todo minúsculas, sin signos de exclamación.
Distinto al subject original. Nunca "re:" ni "seguimiento" ni "follow up".

LONGITUD — LÍMITE DURO: body completo de 40 a 80 palabras.
Más corto que el original. Máximo 2 oraciones por párrafo.

PROHIBIDO ABSOLUTO:
- Mencionar que abrió, leyó, vio o recibió el email anterior
- Reprochar la falta de respuesta de cualquier forma
- Repetir frases del email original
- Presentarte de nuevo con nombre completo (ya se presentó la primera vez)

FRASES PROHIBIDAS:
espero que este correo lo encuentre bien, me pongo en contacto,
solución integral, potenciar, sinergia, innovación, a medida,
en el mercado actual, me complace, le escribo para ofrecerle,
no dude en contactarme, mundo digital, presencia online,
era digital, transformación digital, estamos para ayudarlo,
podría ser que, quizás le interese, me permito contactarlo,
quedo a su disposición, será un placer, gracias por su tiempo,
gracias por leer, actualmente, en la actualidad, hoy en día,
hemos trabajado, contamos con, nuestro equipo

Responder ÚNICAMENTE con JSON válido, sin texto adicional, sin markdown:
{"subject":"...","body":"..."}`;

const FOLLOWUP_EN = `You are a B2B cold email copywriter. Plain, direct American English.
You are writing a FOLLOW-UP: you already sent this business a first email
a few days ago and got no reply. The original email is in the user message.

DATA (in the user message):
name, category, neighbourhood, daysSinceSent,
originalSubject, originalBody (the first email; may be null),
wasOpened (true if they opened the first email — NEVER mention this)

STRUCTURE (in order):
1. Brief neutral reference to the first email — ONE sentence.
   Model: "I emailed you a few days ago about [topic of original email]."
   If originalBody is null: "I emailed you a few days ago about your business website."
   BANNED: any guilt-trip — never "I haven't heard back", "since you didn't
   reply", "I know you're busy".
2. NEW angle — one paragraph, max 2 sentences.
   Do NOT repeat the original pitch. Pick a DIFFERENT benefit or problem
   than the first email, relevant to their category.
   If wasOpened is true: be more concrete and direct about the value
   (a tangible outcome, a specific example for their industry).
   If wasOpened is false: restate the value proposition from scratch
   in different words, as if they're reading it for the first time.
3. Soft CTA — ONE short sentence.
   Examples: "Worth a quick chat this week?" "Happy to show you an example in 10 minutes."
4. Close: nothing — no sign-off, no name.

SUBJECT: 3–5 words, all lowercase, no exclamation marks.
Different from the original subject. Never "re:" or "follow up" or "checking in".

LENGTH — HARD LIMIT: full body 40–80 words. Shorter than the original.

ABSOLUTELY BANNED:
- Mentioning they opened, read, saw, or received the previous email
- Guilt-tripping about the lack of reply in any form
- Repeating phrases from the original email
- Re-introducing yourself (you already did in the first email)

BANNED PHRASES:
I hope this email finds you well, I wanted to reach out,
I came across your business, synergy, leverage, innovative,
cutting-edge, tailored solutions, in today's competitive landscape,
I'd love to connect, let's hop on a call, feel free to reach out,
don't hesitate to contact me, take your business to the next level,
just checking in, just following up, just bumping this

Reply ONLY with valid JSON, no extra text, no markdown:
{"subject":"...","body":"..."}`;

async function callGemini(systemPrompt: string, userPayload: Record<string, unknown>): Promise<{ subject: string; body: string }> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash',
    systemInstruction: systemPrompt,
  });

  const result = await model.generateContent(JSON.stringify(userPayload));
  const text = result.response.text().trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof (parsed as Record<string, unknown>).subject !== 'string' ||
    typeof (parsed as Record<string, unknown>).body !== 'string'
  ) {
    throw new Error(`Gemini JSON missing subject/body: ${text.slice(0, 200)}`);
  }

  return {
    subject: (parsed as { subject: string; body: string }).subject,
    body: (parsed as { subject: string; body: string }).body,
  };
}

export async function composeFollowUp(
  business: BusinessForEmail,
  original: { subject: string; body: string } | null,
  daysSinceSent: number | null,
  wasOpened: boolean,
): Promise<{ subject: string; body: string }> {
  const isArgentina = business.locCountry === 'Argentina';
  const systemPrompt = (isArgentina ? FOLLOWUP_ES : FOLLOWUP_EN)
    .replaceAll('{{GREETING}}', getGreeting())
    .replaceAll('{{PROFESSIONAL_TITLE}}', getProfessionalTitle(business.category));

  return callGemini(systemPrompt, {
    name: business.name,
    category: business.category,
    neighbourhood: business.locNeighbourhood,
    daysSinceSent,
    originalSubject: original?.subject ?? null,
    originalBody: original?.body ?? null,
    wasOpened,
  });
}

export async function composeEmail(
  business: BusinessForEmail,
  analysis?: WebsiteAnalysis,
  approvedExample?: { subject: string; body: string } | null,
): Promise<{ subject: string; body: string; topGap: string | null }> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const offerContext = buildOfferContext(business);
  const isArgentina = business.locCountry === 'Argentina';
  const analysisContext = analysis?.loadedSuccessfully ? buildAnalysisContext(business, analysis, isArgentina) : '';
  const greeting = getGreeting();
  const title = getProfessionalTitle(business.category);
  const systemPrompt = (isArgentina ? SYSTEM_ES : SYSTEM_EN)
    .replace('{{OFFER_CONTEXT}}', offerContext + analysisContext)
    .replaceAll('{{GREETING}}', greeting)
    .replaceAll('{{PROFESSIONAL_TITLE}}', title);

  let userPayload: Record<string, unknown> = {
    name: business.name,
    category: business.category,
    neighbourhood: business.locNeighbourhood,
    rating: business.rating,
    reviewCount: business.reviewCount,
    website: normalizeWebsite(business.website) || null,
  };

  let topGap: string | null = null;

  if (isArgentina) {
    const { gaps, count } =
      analysis?.loadedSuccessfully
        ? buildAnalysisGaps(business, analysis)
        : { gaps: [], count: 0 };
    topGap = gaps[0] ?? null;
    const example =
      approvedExample !== undefined
        ? approvedExample
        : getMatchingExample(topGap, getCategoryBucket(business.category));
    userPayload = {
      ...userPayload,
      siteGaps: gaps,
      gapCount: count,
      platform: analysis?.platform ?? 'custom',
      ...(analysis?.hasLiveChatWidget ? {
        existingChatNote: 'This site already has a live chat widget. Do not position a chatbot as something new or missing — they already have real-time chat. Only mention it if directly relevant to a different gap.',
      } : {}),
      ...(analysis?.platform && analysis.platform !== 'custom' ? {
        platformNote: `Site runs on ${analysis.platform}.`,
      } : {}),
      ...(example
        ? {
            approvedExample: example,
            approvedExampleNote:
              'Use this as primary reference for tone and length. The business above is different — adapt completely. Do not copy phrases.',
          }
        : {}),
    };
  }

  const { subject, body } = await callGemini(systemPrompt, userPayload);
  return { subject, body, topGap };
}
