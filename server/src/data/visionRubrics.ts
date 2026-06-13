const RUBRICS: Record<string, string> = {
  food: 'Evaluate: food photography quality and visual appeal; menu accessibility and readability; reservation or order path visibility; mobile layout and text legibility on small screen.',
  professional: 'Evaluate: team or office photography and credibility signals; service or specialty clarity; intake or consultation path friction; trust elements such as awards or certifications.',
  trades: 'Evaluate: proof-of-work gallery or before/after photos; service area and coverage clarity; quote-request or contact path friction; equipment or fleet visibility.',
  retail: 'Evaluate: product imagery quality and context; pricing visibility; checkout or cart path clarity; product description completeness.',
  default: 'Evaluate: visual professionalism and brand consistency; contact accessibility; service or product clarity; mobile experience on small screen.',
};

const FOOD_RX = /restaurant|café|cafe|bar|comida|panadería|panaderia|heladería|heladeria|pizz|delivery|cocina|sushi|burger|parrilla|bistro|cafetería|cafeteria|pastelería|pasteleria|confitería|confiteria/i;
const PROFESSIONAL_RX = /abogad|jur[ií]dic|bufete|legal|m[eé]dic|cl[ií]nic|doctor|salud|odontolog|psicolog|arquitect|contad|contable|contador|notari|asesor/i;
const TRADES_RX = /plomer|electric|pintor|construc|carpinter|jardin|limpieza|mudanza|herrer|cerrajer|techista|gasista|instalador/i;
const RETAIL_RX = /tienda|store|shop|boutique|ferretería|ferreteria|librería|libreria|farmacia|óptica|optica|mueble|electrónica|electronica|indumentaria|ropa|calzado/i;

export function getRubric(category: string | null): string {
  if (!category) return RUBRICS.default;
  if (FOOD_RX.test(category)) return RUBRICS.food;
  if (PROFESSIONAL_RX.test(category)) return RUBRICS.professional;
  if (TRADES_RX.test(category)) return RUBRICS.trades;
  if (RETAIL_RX.test(category)) return RUBRICS.retail;
  return RUBRICS.default;
}
