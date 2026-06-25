// Deterministic em-dash sanitizer (slice 0034). Em dashes are the #1 AI-slop tell;
// this strips the whole dash family right before text is shown/sent so no draft —
// even a hand-edited one — can ship a `—`. Replacement is a comma+space (operator
// choice), which reads naturally whether the dash joined clauses or was parenthetical.
// ponytail: this is the CERTAIN guard. The prompt rules are best-effort; this runs last.
export function stripEmDashes(s: string): string {
  if (!s) return s;
  return s
    .replace(/\s*[—–―]\s*/g, ', ')   // em/en/horizontal-bar (any spacing) → comma+space
    .replace(/,\s*,/g, ',')          // collapse doubled commas
    .replace(/,\s*([.;:!?])/g, '$1') // ", ." → "." (dash before terminal punctuation)
    .replace(/[ \t]{2,}/g, ' ')      // collapse runs of spaces
    .replace(/^\s*,\s*/, '')         // drop leading comma (dash at start)
    .replace(/\s*,\s*$/, '')         // drop trailing comma (dash at end)
    .trim();
}

// One runnable self-check, no framework. Run:
//   docker compose -f docker-compose.dev.yml exec server \
//     sh -c "cd /app/server && npx tsx src/services/textSanitizer.ts"
if (require.main === module) {
  const eq = (actual: string, expected: string) => {
    if (actual !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  eq(stripEmDashes('a — b'), 'a, b');
  eq(stripEmDashes('a—b'), 'a, b');
  eq(stripEmDashes('— x'), 'x');
  eq(stripEmDashes('x —'), 'x');
  eq(stripEmDashes('a — b — c'), 'a, b, c');
  eq(stripEmDashes('a–b'), 'a, b');           // en dash
  eq(stripEmDashes('foo ― bar'), 'foo, bar'); // horizontal bar
  eq(stripEmDashes('no dash here'), 'no dash here');
  eq(stripEmDashes('ends — .'), 'ends.');
  eq(stripEmDashes(''), '');
  console.log('textSanitizer self-check: all assertions passed');
}
