import { SchemaType } from '@google/generative-ai';
import { withGeminiRate, GeminiRpdExhausted, GeminiProviderExhausted, describeGeminiError } from './geminiRateLimiter';
import { makeGenerate } from './aiProvider';
import { createQuarantine } from './modelQuarantine';
import type { ResponseSchema } from '@google/generative-ai';
import { z } from 'zod';
import { env } from '../env';
import type { WebsiteAnalysis } from './websiteAnalyzer';
import { getMatchingExample, getCategoryBucket } from '../db';
import type { DetectedSig, SignalMap } from '../db/premium';
import type { PsiData } from '../db/psiCache';
import type { VisionResult } from './visionClient';
import type { AnchorCandidate } from './anchorRanker';
import { getString, getNumber } from './appSettings';

// Structured composer output. The composer declares the anchor it built the
// opening on, plus every website claim it made (each tied to an evidenceRef) so
// the verifier can grade a declared claim list instead of re-extracting from prose.
const ComposedClaimSchema = z.object({
  text: z.string(),
  evidenceRef: z.string(),
  kind: z.string(),
});
const ComposedEmailSchema = z.object({
  subject: z.string(),
  openingSentence: z.string(),
  body: z.string(),
  anchorId: z.string(),
  claims: z.array(ComposedClaimSchema),
});
export type ComposedClaim = z.infer<typeof ComposedClaimSchema>;
export type ComposedEmail = z.infer<typeof ComposedEmailSchema>;

const COMPOSED_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    subject: { type: SchemaType.STRING },
    openingSentence: { type: SchemaType.STRING },
    body: { type: SchemaType.STRING },
    anchorId: { type: SchemaType.STRING },
    claims: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          text: { type: SchemaType.STRING },
          evidenceRef: { type: SchemaType.STRING },
          kind: { type: SchemaType.STRING },
        },
        required: ['text', 'evidenceRef', 'kind'],
      },
    },
  },
  required: ['subject', 'openingSentence', 'body', 'anchorId', 'claims'],
};

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

function buildAnalysisContext(b: BusinessForEmail, a: WebsiteAnalysis, isAR: boolean, detectedSigs?: DetectedSig[], absentVerifiedKeys?: Set<string>): string {
  const cat = b.category ?? '';
  const isBookable = BOOKABLE_CATS.test(cat);
  const isFood = FOOD_CATS.test(cat);

  // Suppression helpers — only fire when scanner produced a PRESENT-grade detection
  const sigCats = new Set(detectedSigs?.map(s => s.category) ?? []);
  const hasBookingSig = sigCats.has('booking');
  const hasWhatsappSig = sigCats.has('whatsapp');
  const hasFormSig = sigCats.has('forms');

  const gaps: { ar: string; en: string; priority: number }[] = [];

  // Raw-fetch negatives are hedged ("no muestra … a primera vista"): a raw
  // fetch can't see JS-injected widgets, so absence is never asserted as fact.
  // Positively-observed facts (SSL protocol) stay flat.
  if (isBookable && !a.hasOnlineBooking && !hasBookingSig)
    gaps.push({ ar: 'no muestra un sistema de turnos online a primera vista', en: 'no visible online booking option', priority: 10 });
  if (isFood && !a.hasMenuOrServices)
    gaps.push({ ar: 'no muestra el menú online a primera vista', en: 'no visible online menu', priority: 10 });
  // Suppress mobile gap if ABSENT_VERIFIED — buildSignalContext covers it with a hedged block instead
  if (!a.hasViewportMeta && !absentVerifiedKeys?.has('hasViewportMeta'))
    gaps.push({ ar: 'no parece estar optimizado para móviles', en: 'the site does not appear mobile-optimized', priority: 8 });
  if (isAR && !a.hasWhatsappLink && !hasWhatsappSig)
    gaps.push({ ar: 'no muestra un botón de WhatsApp a primera vista', en: '', priority: 7 });
  if (!a.hasContactForm && !hasFormSig)
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
  a: WebsiteAnalysis,
  detectedSigs?: DetectedSig[],
  absentVerifiedKeys?: Set<string>,
): { gaps: string[]; count: number } {
  const cat = b.category ?? '';
  const isBookable = BOOKABLE_CATS.test(cat);
  const isFood = FOOD_CATS.test(cat);

  // Suppression helpers — only fire when scanner produced a PRESENT-grade detection
  const sigCats = new Set(detectedSigs?.map(s => s.category) ?? []);
  const hasBookingSig = sigCats.has('booking');
  const hasWhatsappSig = sigCats.has('whatsapp');
  const hasChatSig = sigCats.has('chat');
  const hasFormSig = sigCats.has('forms');

  const raw: { label: string; priority: number }[] = [];

  // Hedged negatives, same reasoning as buildAnalysisContext: raw fetch can't
  // prove absence. Positively-observed facts (copyright, script count, SSL,
  // OpenGraph share behavior) stay flat.
  if (isBookable && !a.hasOnlineBooking && !hasBookingSig)
    raw.push({ label: 'no muestra un sistema de turnos online a primera vista', priority: 10 });
  if (isFood && !a.hasMenuOrServices)
    raw.push({ label: 'no muestra el menú online a primera vista', priority: 10 });
  if (a.siteAppearsOutdated && a.copyrightYear)
    raw.push({ label: `el copyright del sitio dice ${a.copyrightYear} — puede parecer inactivo o desactualizado`, priority: 9 });
  // Suppress mobile gap if ABSENT_VERIFIED — buildSignalContext covers it instead
  if (!a.hasViewportMeta && !absentVerifiedKeys?.has('hasViewportMeta'))
    raw.push({ label: 'no parece estar optimizado para móviles', priority: 8 });
  if (!a.hasWhatsappLink && !hasWhatsappSig)
    raw.push({ label: 'no muestra un botón de WhatsApp a primera vista', priority: 7 });
  if (a.scriptCount !== undefined && a.scriptCount > 20)
    raw.push({ label: `carga con ${a.scriptCount} scripts externos, lo que lo ralentiza en dispositivos móviles`, priority: 6 });
  if (!a.hasContactForm && !hasFormSig)
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

function buildPsiContext(psiData: PsiData | null | undefined, isAR: boolean): string {
  if (!psiData || psiData.mobileScore === null) return '';
  const score = psiData.mobileScore;
  if (score >= 75) return '';

  const lcpSec = psiData.lcp !== null ? (psiData.lcp / 1000).toFixed(1) : null;

  if (isAR) {
    const lcpPart = lcpSec ? ` LCP (carga del contenido principal): ${lcpSec}s.` : '';
    if (score < 50) {
      return `\n\nRENDIMIENTO MÓVIL MEDIDO (dato verificable): puntuación ${score}/100 en Google PageSpeed Insights (móvil).${lcpPart} Estos valores son reales y el destinatario puede comprobarlo en segundos. USAR este número como dato concreto en el email — es el tipo de observación más creíble porque es verificable de inmediato. Citar el número exacto: "${score}/100".`;
    }
    return `\n\nRENDIMIENTO MÓVIL: puntuación ${score}/100 en PageSpeed Insights.${lcpPart} Mencionar solo si no hay un problema más urgente.`;
  }

  const lcpPart = lcpSec ? ` LCP: ${lcpSec}s.` : '';
  if (score < 50) {
    return `\n\nMEASURED MOBILE PERFORMANCE (verifiable fact): score ${score}/100 on Google PageSpeed Insights.${lcpPart} Recipient can verify this in seconds. USE this number as a concrete observation in the email — cite the exact score: "${score}/100".`;
  }
  return `\n\nMOBILE PERFORMANCE: score ${score}/100 on PageSpeed Insights.${lcpPart} Mention only if no more urgent gap.`;
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

// Outreach locale from the lead's country. Argentina → es-AR (usted/voseo prompt),
// Spain → es-ES (Castilian tú prompt), everything else → English. Previously this was
// a binary `=== 'Argentina'` check that silently sent Spanish leads English copy.
type Locale = 'es-AR' | 'es-ES' | 'en';
function resolveLocale(locCountry: string | null): Locale {
  const c = (locCountry ?? '').trim().toLowerCase();
  if (c === 'argentina') return 'es-AR';
  if (c === 'spain' || c === 'españa' || c === 'espana') return 'es-ES';
  return 'en';
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
{{TONE_DIRECTIVE}}

2. Hook + consecuencia — un párrafo, exactamente 2 oraciones conectadas.
   Si siteGaps tiene elementos: el hook ES siteGaps[0], redactado como
   observación directa sobre este negocio específico. No sobre "muchos negocios".
   La CONSECUENCIA va con modal suave (puede, podría, suele, es posible que).
   Modelo: "El sitio de [nombre o categoría] en [neighbourhood] [siteGaps[0]]
   — puede hacer que los clientes que llegan fuera de horario no tengan cómo comunicarse."
   Si siteGaps está vacío: anclá en neighbourhood + categoría con un dato
   concreto (rating, tipo de servicio). Nunca generalices a "muchos negocios".
   PROHIBIDO como primera oración del hook:
   "Muchos [categoría] en [barrio]..." — es genérico, no habla de este negocio.
   "Revisé / noté / encontré / vi su sitio..." — el hook no narra tu proceso.
3. Oferta — un párrafo, máximo 2 oraciones que fluyan entre sí.
   Si gapCount == 0: ofrecé el asistente virtual con IA como propuesta principal.
   Si gapCount 1–2: ofrecé la solución a siteGaps[0]. No menciones el asistente.
   Si gapCount 3+: ofrecé la solución a siteGaps[0] en la primera oración.
   Oferta del asistente virtual (redactala con estas palabras, adaptando lo mínimo):
   {{ASSISTANT_OFFER}}
   GATE DEL ASISTENTE — la oferta del asistente es un servicio que YO ofrezco
   (siempre verdadero), presentala como beneficio. AFIRMAR que ESTE negocio NO
   tiene un asistente es una afirmación sobre su sitio: hacelo ÚNICAMENTE si
   requiredAnchor.fact lo dice. Si no, ofrecé el asistente como beneficio sin
   afirmar nunca que les falta.
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

El sitio de su estudio en Núñez no muestra WhatsApp ni un formulario de contacto a primera vista — puede hacer que los clientes que llegan de noche o el fin de semana se queden sin una forma rápida de comunicarse.

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
- Condicionales suavizadores ("podría", "quizás", "si le interesa") en la OFERTA: la oferta va directa. (En la CONSECUENCIA de la observación del sitio los modales suaves son obligatorios — ver tono.)
- Elogios sin dato concreto del negocio
- Bullets, listas o numeración de cualquier tipo
- Mencionar credenciales, años de experiencia o clientes anteriores
- Párrafo de una sola oración suelta (excepto saludo y cierre)
- Ofrecer propuesta, portfolio o materiales adicionales

Responder ÚNICAMENTE con JSON válido, sin texto adicional, sin markdown:
{"subject":"...","body":"..."}`;

const SYSTEM_EN = `You are a B2B cold email copywriter. Plain, direct American English.
Sound like a real person, not a company or agency.

{{TONE_DIRECTIVE}}

STRUCTURE (follow in order):
1. Hook: one specific detail about their business — neighbourhood, category,
   rating, or something concrete from their web presence
2. Problem: one friction that type of business typically has online.
   Phrase the consequence with a soft modal (may, might, often, tends to).
   Model: "...at first glance, which may make after-hours visitors leave."
3. Offer: {{OFFER_CONTEXT}}
   You may also weave in the AI assistant offer (use this wording, adapt minimally):
   {{ASSISTANT_OFFER}}
   ASSISTANT GATE — the assistant offer is a service I provide (always true); present
   it as a benefit. Claiming THIS business HAS NO assistant is a claim about their site:
   do that ONLY if requiredAnchor.fact says so. Otherwise offer it as a benefit and never
   assert they lack one.
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

FORMATTING — HARD RULE:
- Separate every paragraph with a blank line (a literal \\n\\n in the JSON body string).
- The body is ALWAYS 4 short paragraphs in this order: (1) hook + problem, (2) offer,
  (3) one-line intro, (4) one-line CTA. Never collapse them into one block.

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

CORRECT EXAMPLE — 72 words, four blank-line-separated paragraphs. Match this shape exactly:

subject: "your clinic in saavedra"
body:
Your clinic's site in Saavedra shows no online booking at first glance, which may push after-hours visitors to call someone else instead.

I build simple booking flows that let patients reserve a slot in seconds, and I also design AI assistants that answer common questions 24/7 so nothing slips overnight.

I'm a web developer working with local businesses in the area.

Got 10 minutes this week to chat about it?

INCORRECT — never do this (everything crammed into one paragraph, no blank lines):
"Your clinic shows no online booking which may lose visitors. I build booking flows and AI assistants that answer 24/7. I'm a web developer working with local businesses. Got 10 minutes this week to chat?"

Reply ONLY with valid JSON, no extra text, no markdown. In the body string, paragraphs MUST be separated by \\n\\n:
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

// Castilian (peninsular) Spanish composer. Same structure as SYSTEM_ES but tú
// register (Spain) instead of usted/voseo (Argentina). Used for loc_country=Spain.
const SYSTEM_ES_ES = `Eres un copywriter de cold email B2B para negocios en España.

VOZ: primera persona del singular únicamente.
Nunca "nosotros", "implementamos", "ofrecemos", "trabajamos".
Siempre: "implemento", "trabajo", "desarrollo", "diseño".

REGISTRO: tutea siempre (tú). Nunca "usted", nunca "vos". Castellano peninsular.

DATOS DEL NEGOCIO (en el mensaje del usuario):
name, category, neighbourhood, rating, reviewCount, website,
siteGaps (array de problemas detectados en el sitio, puede estar vacío),
gapCount (0 = sitio sólido · 1–2 = hay brechas · 3+ = varios problemas)

ESTRUCTURA (en orden, párrafos fluidos — nunca una oración suelta por párrafo):
1. {{GREETING}}, {{PROFESSIONAL_TITLE}}
   (línea en blanco después del saludo)
{{TONE_DIRECTIVE}}

2. Hook + consecuencia — un párrafo, exactamente 2 oraciones conectadas.
   Si siteGaps tiene elementos: el hook ES siteGaps[0], redactado como
   observación directa sobre este negocio específico. No sobre "muchos negocios".
   La CONSECUENCIA va con modal suave (puede, podría, suele, es posible que).
   Modelo: "La web de [nombre o categoría] en [neighbourhood] [siteGaps[0]]
   — puede hacer que los clientes que entran fuera de horario no sepan cómo contactar."
   Si siteGaps está vacío: ancla en neighbourhood + categoría con un dato
   concreto (rating, tipo de servicio). Nunca generalices a "muchos negocios".
   PROHIBIDO como primera oración del hook:
   "Muchos [categoría] en [barrio]..." — es genérico, no habla de este negocio.
   "Revisé / vi / encontré tu web..." — el hook no narra tu proceso.
3. Oferta — un párrafo, máximo 2 oraciones que fluyan entre sí.
   Si gapCount == 0: ofrece el asistente virtual con IA como propuesta principal.
   Si gapCount 1–2: ofrece la solución a siteGaps[0]. No menciones el asistente.
   Si gapCount 3+: ofrece la solución a siteGaps[0] en la primera oración.
   Oferta del asistente virtual (redáctala con estas palabras, adaptando lo mínimo):
   {{ASSISTANT_OFFER}}
   GATE DEL ASISTENTE — la oferta del asistente es un servicio que YO ofrezco
   (siempre verdadero), preséntala como beneficio. AFIRMAR que ESTE negocio NO
   tiene un asistente es una afirmación sobre su web: hazlo ÚNICAMENTE si
   requiredAnchor.fact lo dice. Si no, ofrece el asistente como beneficio sin
   afirmar nunca que les falta.
4. Presentación — una oración exacta, sin cambios:
   "Me llamo Santiago Vittor, soy desarrollador web y trabajo con
   negocios de la zona."
5. CTA — dos oraciones exactas, sin cambios:
   "¿Tienes 10 minutos esta semana para hablarlo?
   Quedo a disposición para cualquier consulta."
6. Cierre — una sola palabra: "Un saludo,"

SUBJECT — 3 a 5 palabras, todo minúsculas, sin signos de exclamación.
Debe mencionar al menos uno de: neighbourhood, categoría abreviada, o el gap principal.
INCORRECTO: "sobre tu web" · "propuesta para tu negocio" · "mejoras digitales"
CORRECTO: "tu clínica en Chamberí" · "reservas online para el estudio" · "contacto en tu peluquería"

LONGITUD — LÍMITE DURO. Cuenta las palabras antes de responder:
Body completo (desde el saludo hasta "Un saludo,"): 70 a 90 palabras.
Máximo 2 oraciones por párrafo. Máximo 18 palabras por oración.
Si superas 90 palabras, reescribe hasta entrar en el límite.

EJEMPLO CORRECTO — 80 palabras, referencia de longitud y tono (párrafos separados por línea en blanco):

subject: "tu estudio en Chamberí"
body:
Buenas tardes,

La web de tu estudio en Chamberí no muestra WhatsApp ni un formulario de contacto a primera vista — puede hacer que los clientes que entran de noche o el fin de semana se queden sin una forma rápida de contactar.

Trabajo con un asistente de chat con IA que responde consultas básicas las 24 horas y deja todo registrado para que lo retomes cuando puedas.

Me llamo Santiago Vittor, soy desarrollador web y trabajo con negocios de la zona.

¿Tienes 10 minutos esta semana para hablarlo? Quedo a disposición para cualquier consulta.

Un saludo,

FRASES PROHIBIDAS:
espero que este correo te encuentre bien, me pongo en contacto,
solución integral, potenciar, sinergia, innovación, a medida,
en el mercado actual, me complace, te escribo para ofrecerte,
no dudes en contactarme, mundo digital, presencia online,
era digital, transformación digital, estamos para ayudarte,
podría ser que, quizás te interese, me permito contactarte,
quedo a tu disposición, será un placer, gracias por tu tiempo,
gracias por leer, actualmente, en la actualidad, hoy en día,
hemos trabajado, contamos con, nuestro equipo

ESTRUCTURAS PROHIBIDAS:
- Hook genérico: "Muchos [categoría] en [barrio]..." en vez del negocio específico
- Hook narrativo: verbos que narran tu proceso ("revisé", "vi", "encontré")
- Primera oración del email comenzando con "Yo"
- Cualquier forma de nosotros: implementamos, ofrecemos, hacemos, trabajamos
- Tratar de usted o usar "vos" en cualquier parte
- Condicionales suavizadores ("podría", "quizás", "si te interesa") en la OFERTA: la oferta va directa. (En la CONSECUENCIA de la observación del sitio los modales suaves son obligatorios — ver tono.)
- Elogios sin dato concreto del negocio
- Bullets, listas o numeración de cualquier tipo
- Mencionar credenciales, años de experiencia o clientes anteriores
- Párrafo de una sola oración suelta (excepto saludo y cierre)
- Ofrecer propuesta, portfolio o materiales adicionales

Responder ÚNICAMENTE con JSON válido, sin texto adicional, sin markdown:
{"subject":"...","body":"..."}`;

const FOLLOWUP_ES_ES = `Eres un copywriter de cold email B2B para negocios en España.
Estás escribiendo un FOLLOW-UP: ya enviaste un primer email a este negocio
hace unos días y no respondió. El email original está en el mensaje del usuario.

VOZ: primera persona del singular únicamente.
Nunca "nosotros", "implementamos", "ofrecemos", "trabajamos".
Siempre: "implemento", "trabajo", "desarrollo", "diseño".

REGISTRO: tutea siempre (tú). Nunca "usted", nunca "vos". Castellano peninsular.

DATOS (en el mensaje del usuario):
name, category, neighbourhood, daysSinceSent,
originalSubject, originalBody (el primer email; puede ser null),
wasOpened (true si abrió el primer email — NUNCA mencionar esto)

ESTRUCTURA (en orden):
1. {{GREETING}}, {{PROFESSIONAL_TITLE}}
   (línea en blanco después del saludo)
2. Referencia breve y neutral al primer email — UNA oración.
   Modelo: "Te escribí hace unos días sobre [tema del email original]."
   Si originalBody es null: "Te escribí hace unos días sobre la web de tu negocio."
   PROHIBIDO: cualquier reproche — nunca "no recibí respuesta",
   "no tuve noticias", "como no me contestaste".
3. Ángulo NUEVO — un párrafo, máximo 2 oraciones.
   NO repitas el pitch del email original. Elige un beneficio o problema
   DISTINTO al que usaste la primera vez, relevante para su categoría.
   Si wasOpened es true: sé más concreto y directo sobre el valor.
   Si wasOpened es false: replantea la propuesta de valor desde cero con otras palabras.
4. CTA suave — UNA oración corta.
   Ejemplos: "¿Te interesa que lo veamos esta semana?"
   "Si te sirve, te enseño un ejemplo en 10 minutos."
5. Cierre — una sola palabra: "Un saludo,"

SUBJECT — 3 a 5 palabras, todo minúsculas, sin signos de exclamación.
Distinto al subject original. Nunca "re:" ni "seguimiento" ni "follow up".

LONGITUD — LÍMITE DURO: body completo de 40 a 80 palabras.
Más corto que el original. Máximo 2 oraciones por párrafo.

PROHIBIDO ABSOLUTO:
- Mencionar que abrió, leyó, vio o recibió el email anterior
- Reprochar la falta de respuesta de cualquier forma
- Repetir frases del email original
- Presentarte de nuevo con nombre completo (ya te presentaste la primera vez)
- Tratar de usted o usar "vos"

FRASES PROHIBIDAS:
espero que este correo te encuentre bien, me pongo en contacto,
solución integral, potenciar, sinergia, innovación, a medida,
en el mercado actual, me complace, te escribo para ofrecerte,
no dudes en contactarme, mundo digital, presencia online,
era digital, transformación digital, estamos para ayudarte,
quedo a tu disposición, será un placer, gracias por tu tiempo,
gracias por leer, actualmente, hoy en día, hemos trabajado, contamos con, nuestro equipo

Responder ÚNICAMENTE con JSON válido, sin texto adicional, sin markdown:
{"subject":"...","body":"..."}`;

function buildVisionContext(vision: VisionResult | null | undefined, isAR: boolean): string {
  if (!vision) return '';

  const highStrengths = vision.strengths.filter(s => s.confidence >= 0.8);
  const highOpps = vision.opportunities.filter(s => s.confidence >= 0.75);
  if (!highStrengths.length && !highOpps.length) return '';

  const parts: string[] = [];

  if (highStrengths.length) {
    const label = isAR
      ? 'FORTALEZAS VISIBLES CONFIRMADAS (visibles en el screenshot — pueden citarse como hechos):'
      : 'CONFIRMED VISIBLE STRENGTHS (seen in screenshot — can assert as fact):';
    parts.push(`\n\n${label}\n${highStrengths.map(s => `- ${s.text}`).join('\n')}`);
  }

  if (highOpps.length) {
    const label = isAR
      ? 'OPORTUNIDADES IDENTIFICADAS VISUALMENTE (contexto adicional):'
      : 'VISUALLY IDENTIFIED OPPORTUNITIES (additional context):';
    parts.push(`\n\n${label}\n${highOpps.map(s => `- ${s.text}`).join('\n')}`);
  }

  return parts.join('');
}

// Maps signal keys to human-readable action labels used in hedged observations.
// Only ABSENT_VERIFIED-eligible keys are listed here (widget signals excluded by design).
const SIGNAL_HEDGE_LABELS: Record<string, { ar: { feature: string; action: string }; en: { feature: string; action: string } }> = {
  hasViewportMeta: {
    ar: { feature: 'optimización para móviles (viewport meta)', action: 'navegar cómodamente desde el celular' },
    en: { feature: 'mobile optimization (viewport meta)', action: 'view the site comfortably on mobile' },
  },
};

function buildSignalContext(signalMap: SignalMap | undefined, isAR: boolean): string {
  if (!signalMap) return '';

  const absentHedges: string[] = [];
  for (const [key, signal] of Object.entries(signalMap)) {
    if (signal.state !== 'ABSENT_VERIFIED') continue; // PRESENT already covered; UNKNOWN intentionally omitted
    const labels = SIGNAL_HEDGE_LABELS[key];
    if (!labels) continue; // unknown signal key — skip
    const l = isAR ? labels.ar : labels.en;
    absentHedges.push(isAR
      ? `- ${l.feature}: "No encontré una forma sencilla de ${l.action} — si está disponible, no era visible a primera vista, lo que en sí mismo puede generar fricción."`
      : `- ${l.feature}: "I couldn't find an easy way to ${l.action} — if it's there it wasn't obvious, which is itself worth fixing."`
    );
  }

  if (!absentHedges.length) return '';

  if (isAR) {
    return `\n\nAUSENCIAS VERIFICADAS POR MÚLTIPLES DETECTORES (render + DOM + red + visión confirmaron ausencia): usar lenguaje observacional — NUNCA afirmar ausencia como hecho absoluto. Redactar exactamente como observación personal:\n${absentHedges.join('\n')}`;
  }
  return `\n\nVERIFIED ABSENCES (render + DOM + network + vision all found nothing): use observational phrasing — NEVER assert absence as absolute fact. Phrase as personal observation:\n${absentHedges.join('\n')}`;
}

async function callGemini(systemPrompt: string, userPayload: Record<string, unknown>): Promise<{ subject: string; body: string }> {
  const composeModel = getString('GEMINI_MODEL');
  const timeoutMs = getNumber('GEMINI_TIMEOUT_MS');
  const generate = makeGenerate({ modelId: composeModel, systemInstruction: systemPrompt, json: true });
  const result = await withGeminiRate(
    signal => generate(JSON.stringify(userPayload), signal, timeoutMs),
    'compose-followup',
    { timeoutMs, model: composeModel },
  );
  const text = result.response.text().trim();
  // Some models wrap JSON in ```json fences despite the prompt — strip them, as
  // the structured composer path already does.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Gemini returned non-JSON: ${cleaned.slice(0, 200)}`);
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
  const locale = resolveLocale(business.locCountry);
  const followUpPrompt =
    locale === 'es-AR' ? FOLLOWUP_ES : locale === 'es-ES' ? FOLLOWUP_ES_ES : FOLLOWUP_EN;
  const systemPrompt = followUpPrompt
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

// ── WhatsApp cheap-site offer (slice 0007) ─────────────────────────────────────
// No-website leads have no email/social — only a phone. This composes a short,
// first-contact WhatsApp message offering to build a cheap site, anchored on the
// only evidence we have (category + barrio + rating + "no website"). No anchor
// ranker, no verifier gate — there's no website to make claims about. Reuses
// callGemini's transport: the prompt emits { subject: "", body: <message> }.

const WHATSAPP_ES = `Sos un copywriter de mensajes de WhatsApp B2B para negocios en Argentina. Escribís un PRIMER mensaje en frío, breve y humano, para ofrecer crear un sitio web simple y económico a un negocio que NO tiene página web.

Reglas:
- Tratá de usted. Nunca vos.
- Largo de WhatsApp: 2 a 4 oraciones, máximo ~45 palabras. Sin asunto, sin firma, sin enlaces.
- Empezá con el saludo "{{GREETING}}" y, si corresponde por el rubro, el título "{{PROFESSIONAL_TITLE}}".
- Decí que los encontraste en Google Maps y que notaste que no tienen sitio web. Es el gancho; NO digas que eso esté "mal" ni los hagas sentir en falta.
- Ofrecé armarles un sitio web simple, rápido y económico, pensado para su rubro y zona. UN solo beneficio concreto, no una lista.
- Cerrá con una pregunta de bajo compromiso (por ejemplo, si les interesa que les pase una idea).
- Natural, no robótico. Nada de "estimado", nada de mayúsculas gritadas. No inventes datos que no estén en el payload.

Devolvé SOLO JSON: { "subject": "", "body": "<el mensaje de WhatsApp>" }. El campo subject SIEMPRE vacío.`;

const WHATSAPP_ES_ES = `Eres un copywriter de mensajes de WhatsApp B2B para negocios en España. Escribes un PRIMER mensaje en frío, breve y humano, para ofrecer crear una web sencilla y económica a un negocio que NO tiene página web.

Reglas:
- Trata de usted.
- Longitud de WhatsApp: 2 a 4 frases, máximo ~45 palabras. Sin asunto, sin firma, sin enlaces.
- Empieza con el saludo "{{GREETING}}" y, si procede por el sector, el título "{{PROFESSIONAL_TITLE}}".
- Di que los encontraste en Google Maps y que viste que no tienen web. Es el gancho; NO digas que eso esté "mal".
- Ofrece hacerles una web sencilla, rápida y económica, pensada para su sector y zona. UN solo beneficio concreto, no una lista.
- Cierra con una pregunta de bajo compromiso (por ejemplo, si les interesa que les pases una idea).
- Natural, no robótico. No inventes datos que no estén en el payload.

Devuelve SOLO JSON: { "subject": "", "body": "<el mensaje de WhatsApp>" }. El campo subject SIEMPRE vacío.`;

const WHATSAPP_EN = `You are a B2B WhatsApp copywriter. You write a FIRST cold message, short and human, offering to build a simple, affordable website for a business that has NO website.

Rules:
- Plain, direct, friendly American English.
- WhatsApp length: 2 to 4 sentences, max ~45 words. No subject, no signature, no links.
- Mention you found them on Google Maps and noticed they don't have a website. That's the hook; do NOT say that's "bad" or make them feel behind.
- Offer to build a simple, fast, affordable site tailored to their category and area. ONE concrete benefit, not a list.
- Close with a low-commitment question (e.g. whether they'd like you to share an idea).
- Natural, not robotic. Don't invent facts not in the payload.

Return ONLY JSON: { "subject": "", "body": "<the WhatsApp message>" }. The subject field is ALWAYS empty.`;

// Compose a first-contact WhatsApp cheap-site offer for a no-website lead.
export async function composeWhatsApp(
  business: BusinessForEmail,
): Promise<{ message: string }> {
  const locale = resolveLocale(business.locCountry);
  const waPrompt =
    locale === 'es-AR' ? WHATSAPP_ES : locale === 'es-ES' ? WHATSAPP_ES_ES : WHATSAPP_EN;
  const systemPrompt = waPrompt
    .replaceAll('{{GREETING}}', getGreeting())
    .replaceAll('{{PROFESSIONAL_TITLE}}', getProfessionalTitle(business.category));

  const { body } = await callGemini(systemPrompt, {
    name: business.name,
    category: business.category,
    neighbourhood: business.locNeighbourhood,
    rating: business.rating,
    reviewCount: business.reviewCount,
  });
  return { message: body };
}

// In-process quarantine for the primary compose model. After 2 consecutive 5xx within
// 5min, skip primary entirely and route directly to the fallback for
// COMPOSE_503_QUARANTINE_MINUTES minutes. Shared factory (slice 0026) — the verifier
// uses the same one.
const composerQuarantine = createQuarantine('COMPOSE_503_QUARANTINE_MINUTES', 'composer');

// Structured composer call: enforces the JSON shape via responseSchema, validates
// with zod, bounded retry on parse failure. Composer keeps its own Gemini client.
async function callGeminiStructured(systemPrompt: string, userPayload: Record<string, unknown>): Promise<ComposedEmail> {
  const composeModel = getString('GEMINI_MODEL');
  const timeoutMs = getNumber('GEMINI_TIMEOUT_MS');
  const fallbackModelId = getString('GEMINI_COMPOSER_FALLBACK_MODEL');

  const runFallback = async (): Promise<ComposedEmail> => {
    const generate = makeGenerate({
      modelId: fallbackModelId, systemInstruction: systemPrompt,
      responseSchema: COMPOSED_RESPONSE_SCHEMA, json: true,
    });
    const fallbackResult = await withGeminiRate(
      signal => generate(JSON.stringify(userPayload), signal, timeoutMs),
      'compose-fallback',
      { timeoutMs, model: fallbackModelId },
    );
    const fallbackText = fallbackResult.response.text().trim();
    const fallbackCleaned = fallbackText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return ComposedEmailSchema.parse(JSON.parse(fallbackCleaned));
  };

  if (composerQuarantine.isQuarantined() && !!fallbackModelId && fallbackModelId !== composeModel) {
    console.warn(`[gemini] composer primary quarantined, routing direct to fallback=${fallbackModelId}`);
    return await runFallback();
  }

  const generate = makeGenerate({
    modelId: composeModel, systemInstruction: systemPrompt,
    responseSchema: COMPOSED_RESPONSE_SCHEMA, json: true,
  });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await withGeminiRate(
        signal => generate(JSON.stringify(userPayload), signal, timeoutMs),
        'compose',
        { timeoutMs, model: composeModel },
      );
      const text = result.response.text().trim();
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = ComposedEmailSchema.parse(JSON.parse(cleaned));
      composerQuarantine.recordSuccess();
      return parsed;
    } catch (err) {
      // RPD / provider exhaustion are run-pause control signals, not parse failures —
      // don't bury them in the generic retry-failure error below; propagate so the
      // batch pauses resumably (and the single-lead path maps to a friendly message).
      if (err instanceof GeminiRpdExhausted || err instanceof GeminiProviderExhausted) throw err;
      const errInfo = describeGeminiError(err);
      if (errInfo.status !== null && errInfo.status >= 500) composerQuarantine.record5xx(composeModel);
      lastErr = err;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const errDesc = describeGeminiError(lastErr);
  const shouldFallback =
    errDesc.status !== null &&
    errDesc.status >= 500 &&
    !!fallbackModelId &&
    fallbackModelId !== composeModel;
  if (shouldFallback) {
    console.warn(
      `[gemini] composer 503 fallback: primary=${composeModel} exhausted ` +
      `(status=${errDesc.status}), trying fallback=${fallbackModelId}`,
    );
    return await runFallback();
  }
  throw new Error(`Composer structured output failed after retries: ${msg}`);
}

// Directive appended to the system prompt instructing the model to build the
// opening on the required anchor and to declare every website claim it makes.
function buildAnchorDirective(anchor: AnchorCandidate, isAR: boolean): string {
  if (isAR) {
    return `\n\nANCLA OBLIGATORIA (requiredAnchor en el payload):
- El hook DEBE construirse sobre requiredAnchor.fact: "${anchor.fact}". Es el dato concreto y específico de ESTE negocio. No lo contradigas ni lo generalices.
- Devolvé "openingSentence": la primera oración del hook, anclada en ese dato.
- Devolvé "anchorId": exactamente "${anchor.id}".
- Devolvé "claims": un array con TODA afirmación factual sobre el SITIO WEB que hagas en el body. Cada claim: { "text": cita textual breve del body, "evidenceRef": el evidenceRef de la evidencia que la respalda (usá "${anchor.evidenceRef}" para el ancla), "kind": "${anchor.kind}" u otro tipo ). Si no hacés ninguna afirmación sobre el sitio más allá del ancla, incluí sólo el claim del ancla. NUNCA afirmes algo del sitio que no esté en claims.`;
  }
  return `\n\nREQUIRED ANCHOR (requiredAnchor in the payload):
- The hook MUST be built on requiredAnchor.fact: "${anchor.fact}". This is the concrete, specific fact about THIS business. Do not contradict or generalize it.
- Return "openingSentence": the first sentence of the hook, anchored on that fact.
- Return "anchorId": exactly "${anchor.id}".
- Return "claims": an array with EVERY factual claim about the WEBSITE you make in the body. Each claim: { "text": short verbatim quote from the body, "evidenceRef": the evidenceRef of the backing evidence (use "${anchor.evidenceRef}" for the anchor), "kind": "${anchor.kind}" or another type }. If you make no website claim beyond the anchor, include only the anchor claim. NEVER assert anything about the site that is not in claims.`;
}

export async function composeEmail(
  business: BusinessForEmail,
  requiredAnchor: AnchorCandidate,
  analysis?: WebsiteAnalysis,
  approvedExample?: { subject: string; body: string } | null,
  detectedSigs?: DetectedSig[],
  psiData?: PsiData | null,
  visionResult?: VisionResult | null,
  signalMap?: SignalMap,
  regenerationFeedback?: string,
): Promise<{ subject: string; body: string; anchorId: string; openingSentence: string; claims: ComposedClaim[]; topGap: string | null }> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const offerContext = buildOfferContext(business);
  const locale = resolveLocale(business.locCountry);
  const isSpanish = locale !== 'en';
  const absentVerifiedKeys = signalMap
    ? new Set(Object.entries(signalMap).filter(([, s]) => s.state === 'ABSENT_VERIFIED').map(([k]) => k))
    : undefined;
  const analysisContext = analysis?.loadedSuccessfully ? buildAnalysisContext(business, analysis, isSpanish, detectedSigs, absentVerifiedKeys) : '';
  const psiContext = buildPsiContext(psiData, isSpanish);
  const visionContext = buildVisionContext(visionResult, isSpanish);
  const signalContext = buildSignalContext(signalMap, isSpanish);
  const greeting = getGreeting();
  const title = getProfessionalTitle(business.category);
  const basePrompt =
    locale === 'es-AR' ? SYSTEM_ES : locale === 'es-ES' ? SYSTEM_ES_ES : SYSTEM_EN;
  const systemPrompt = basePrompt
    .replace('{{OFFER_CONTEXT}}', offerContext + analysisContext + psiContext + visionContext + signalContext)
    .replaceAll('{{TONE_DIRECTIVE}}', getString(isSpanish ? 'SITE_TONE_DIRECTIVE_ES' : 'SITE_TONE_DIRECTIVE_EN'))
    .replaceAll('{{ASSISTANT_OFFER}}', getString(isSpanish ? 'ASSISTANT_OFFER_ES' : 'ASSISTANT_OFFER_EN'))
    .replaceAll('{{GREETING}}', greeting)
    .replaceAll('{{PROFESSIONAL_TITLE}}', title)
    + buildAnchorDirective(requiredAnchor, isSpanish);

  let userPayload: Record<string, unknown> = {
    name: business.name,
    category: business.category,
    neighbourhood: business.locNeighbourhood,
    rating: business.rating,
    reviewCount: business.reviewCount,
    website: normalizeWebsite(business.website) || null,
    requiredAnchor: { id: requiredAnchor.id, fact: requiredAnchor.fact, evidenceRef: requiredAnchor.evidenceRef, kind: requiredAnchor.kind },
    ...(regenerationFeedback ? { verifierFeedback: regenerationFeedback } : {}),
  };

  // The anchor is the authoritative hook for every lead.
  let topGap: string | null = requiredAnchor.fact;

  if (isSpanish) {
    const analysisGaps = analysis?.loadedSuccessfully
      ? buildAnalysisGaps(business, analysis, detectedSigs, absentVerifiedKeys)
      : { gaps: [] as string[], count: 0 };

    // Anchor leads siteGaps so the ES hook rule ("el hook ES siteGaps[0]") fires on it.
    if (analysisGaps.gaps[0] !== requiredAnchor.fact) {
      analysisGaps.gaps.unshift(requiredAnchor.fact);
      analysisGaps.count++;
    }

    const { gaps, count } = analysisGaps;
    const example =
      approvedExample !== undefined
        ? approvedExample
        : getMatchingExample(topGap, getCategoryBucket(business.category));
    userPayload = {
      ...userPayload,
      siteGaps: gaps,
      gapCount: count,
      platform: analysis?.platform ?? 'custom',
      ...((analysis?.hasLiveChatWidget || (detectedSigs?.some(s => s.category === 'chat') ?? false)) ? {
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

  const composed = await callGeminiStructured(systemPrompt, userPayload);
  return {
    subject: composed.subject,
    body: composed.body,
    anchorId: composed.anchorId,
    openingSentence: composed.openingSentence,
    claims: composed.claims,
    topGap,
  };
}
