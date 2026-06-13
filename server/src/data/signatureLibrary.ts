export type SigCategory = 'whatsapp' | 'chat' | 'booking' | 'forms' | 'builder' | 'analytics';

export interface Signature {
  id: string;
  name: string;
  category: SigCategory;
  /** If set, a match upgrades this key in the SignalMap (UNKNOWN → PRESENT). */
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
  // TODO: interaction-gated widgets (e.g. Intercom on DIA supermarket) load only
  // after user action and are invisible to the current single-pass render. Revisit
  // as a 'scroll + network-idle wait' tweak in playwrightRenderer, or cross-check
  // via the vision pass in Slice 4.
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

  // ── Builders / CMS (no signalKey — new category, no existing signal to merge) ─
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
