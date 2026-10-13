// The token names, shared by the generator (scripts/build-theme.mjs) and
// tailwind.config.js, so a hue added here is a class and a variable at once.

export const HUES = ['red', 'amber', 'yellow', 'orange', 'green', 'emerald', 'blue', 'sky', 'indigo', 'violet', 'purple', 'pink', 'rose', 'teal', 'cyan'];
export const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
/** Tokens that are roles rather than scale steps. */
export const ROLE_TOKENS = ['white', 'surface', 'strong', 'strong-hover', 'on-strong', 'chrome', 'chrome-hover', 'chrome-fg', 'chrome-muted'];
export const ALL_TOKENS = [...ROLE_TOKENS, ...STEPS.map((s) => `gray-${s}`), ...HUES.flatMap((h) => STEPS.map((s) => `${h}-${s}`))];
