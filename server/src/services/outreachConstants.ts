// Dependency-free leaf: the single source of truth for the Gmail rolling-24h send
// backstop. Imported by outreachSchedulingConfig (governor send-time clamp),
// settingsRegistry (cap field max / write-reject), and appSettings (read-side clamp)
// so the ceiling lives in exactly ONE place. This module must import nothing from
// config/registry/appSettings — that is what keeps the config↔accessor cycle broken.
export const GMAIL_HARD_CEILING = 400;
