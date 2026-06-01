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

  if (isBookable && !a.hasOnlineBooking)
    gaps.push({ ar: 'no tiene sistema de turnos online', en: 'no online booking system', priority: 10 });
  if (isFood && !a.hasMenuOrServices)
    gaps.push({ ar: 'no tiene menú online', en: 'no online menu', priority: 10 });
  if (!a.hasViewportMeta)
    gaps.push({ ar: 'el sitio no está optimizado para móviles', en: 'the site is not mobile-optimized', priority: 8 });
  if (isAR && !a.hasWhatsappLink)
    gaps.push({ ar: 'no tiene botón de WhatsApp', en: '', priority: 7 });
  if (!a.hasContactForm)
    gaps.push({ ar: 'no tiene formulario de contacto', en: 'no contact form', priority: 5 });
  if (!a.hasSSL)
    gaps.push({ ar: 'corre en HTTP, sin certificado de seguridad', en: 'no SSL certificate', priority: 3 });
  if (!a.pageTitle || a.pageTitle.length < 10)
    gaps.push({ ar: 'el título de la página es genérico o está vacío', en: 'generic or missing page title', priority: 2 });

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

  if (isBookable && !a.hasOnlineBooking)
    raw.push({ label: 'no tiene sistema de turnos online', priority: 10 });
  if (isFood && !a.hasMenuOrServices)
    raw.push({ label: 'no tiene menú online', priority: 10 });
  if (a.siteAppearsOutdated && a.copyrightYear)
    raw.push({ label: `el copyright del sitio dice ${a.copyrightYear} — puede parecer inactivo o desactualizado`, priority: 9 });
  if (!a.hasViewportMeta)
    raw.push({ label: 'el sitio no está optimizado para móviles', priority: 8 });
  if (!a.hasWhatsappLink)
    raw.push({ label: 'no tiene botón de WhatsApp', priority: 7 });
  if (a.scriptCount !== undefined && a.scriptCount > 20)
    raw.push({ label: `carga con ${a.scriptCount} scripts externos, lo que lo ralentiza en dispositivos móviles`, priority: 6 });
  if (!a.hasContactForm)
    raw.push({ label: 'no tiene formulario de contacto', priority: 5 });
  if (!a.hasStructuredData && getCategoryBucket(b.category) !== 'food')
    raw.push({ label: 'no tiene datos estructurados — no aparece con estrellas ni horarios en Google', priority: 5 });
  if (!a.hasOpenGraph)
    raw.push({ label: 'al compartirlo por WhatsApp o redes no muestra imagen ni descripción del negocio', priority: 4 });
  if (!a.hasSSL)
    raw.push({ label: 'corre en HTTP, sin certificado de seguridad', priority: 3 });
  if (!a.hasTestimonials && ['health', 'legal', 'professional'].includes(getCategoryBucket(b.category)))
    raw.push({ label: 'no tiene sección de testimonios o reseñas de clientes en el sitio', priority: 3 });
  if (!a.pageTitle || a.pageTitle.length < 10)
    raw.push({ label: 'el título de la página es genérico o está vacío', priority: 2 });

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

EJEMPLO CORRECTO — 76 palabras, referencia de longitud y tono:

subject: "su estudio en Núñez"
body:
Buenas tardes,

El sitio de su estudio en Núñez no tiene WhatsApp ni formulario de contacto — los clientes que llegan de noche o el fin de semana no tienen cómo comunicarse.

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
  GOOD: "Your accounting firm in Saavedra has no WhatsApp button."

Reply ONLY with valid JSON, no extra text, no markdown:
{"subject":"...","body":"..."}`;

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

  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash',
    systemInstruction: systemPrompt,
  });

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

  const userMessage = JSON.stringify(userPayload);

  const result = await model.generateContent(userMessage);
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
    topGap,
  };
}
