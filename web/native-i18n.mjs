/** Explicit, first-party native presentation boundary. Never apply to token data. */
import nativeSource from './locales/native-en.mjs';
import fragments from './locales/native-fragments.mjs';
const source = { ...nativeSource, ...fragments.en };
import { getLocale, t, jsonUi, presentation, trustedMessage } from './i18n.mjs';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const capturePatterns = {
  'protocol.074': [undefined, escape(source['protocol.060']), escape(source['protocol.059'])],
  'protocol.075': [undefined, undefined, escape(source['protocol.060']), escape(source['protocol.059'])],
  'protocol.076': [undefined, undefined, escape(source['protocol.060']), escape(source['protocol.059'])],
  'protocol.058': ['[^.]*\\.', '[\\s\\S]*?'],
  'protocol.099': ['[\\s\\S]+?', '(?:, and|\\. Nothing)[\\s\\S]*'],
  'protocol.103': ['0x[0-9a-fA-F]+', '[\\s\\S]*'],
  'protocol.200': ['[0-9+-][\\s\\S]*?', '[\\s\\S]*?'],
  'protocol.214': ['[\\s\\S]+?', '(?:\\s+(?:—|until)[\\s\\S]*)?'],
};
const templates = Object.entries(source).map(([key, value]) => {
  const names = [...value.matchAll(/\{(v[0-9]+)\}/g)].map(match => match[1]);
  const parts = value.split(/\{v[0-9]+\}/g);
  return { key, names, literalSize: parts.join('').length,
    pattern: new RegExp(`^${parts.map((part, index) => escape(part) + (index < names.length ? `(${capturePatterns[key]?.[index] ?? '[\\s\\S]*?'})` : '')).join('')}$`) };
}).sort((a, b) => b.literalSize - a.literalSize);
// These captures are themselves first-party prose/labels, identified from the SDK.
// Every other capture is opaque, including addresses, hashes, instants, counts and enums.
const nested = {
  'protocol.048': ['v1'], 'protocol.049': ['v1'], 'protocol.058': ['v0', 'v1'],
  'protocol.073': ['v1'], 'protocol.074': ['v1', 'v2'], 'protocol.075': ['v2', 'v3'],
  'protocol.076': ['v2', 'v3'], 'protocol.077': ['v1'], 'protocol.079': ['v0'],
  'protocol.099': ['v1'], 'protocol.103': ['v1'], 'protocol.111': ['v1'],
  'protocol.147': ['v0'], 'protocol.160': ['v0'], 'protocol.163': ['v0'],
  'protocol.164': ['v0'], 'protocol.206': ['v0'], 'protocol.207': ['v0'],
  'protocol.212': ['v0'], 'protocol.218': ['v0'], 'protocol.224': ['v0'], 'protocol.214': ['v1'], 'protocol.231': ['v0'],
  'protocol.234': ['v0'], 'protocol.244': ['v0'],
};
export function translateNative(text, language = getLocale(), depth = 0) {
  if (language === 'en' || typeof text !== 'string' || depth > 5) return text;
  const match = text.match(/^(\s*(?:[•·] )?)([\s\S]*?)(\s*)$/), [, prefix, body, suffix] = match;
  if (!body) return text;
  // Posture composes a first-party state label with its first-party explanation.
  for (const key of ['protocol.025', 'protocol.026', 'protocol.023', 'protocol.024', 'protocol.040', 'protocol.041', 'protocol.042', 'protocol.043', 'protocol.044']) {
    const label = source[key];
    if (body.startsWith(`${label} — `)) return prefix + t(key, {}, language) + ' — ' + translateNative(body.slice(label.length + 3), language, depth + 1) + suffix;
  }
  for (const { key, names, pattern } of templates) {
    const captures = pattern.exec(body); if (!captures) continue;
    const parameters = Object.fromEntries(names.map((name, index) => [name,
      nested[key]?.includes(name) ? translateNative(captures[index + 1], language, depth + 1) : captures[index + 1]]));
    return prefix + t(key, parameters, language) + (key === 'protocol.fragment.negation' && ['zh-Hans', 'zh-Hant', 'ja'].includes(language) ? '' : suffix);
  }
  return text;
}
export const nativeText = text => presentation(language => translateNative(text, language));
export const nativeUi = (renderer, view) => presentation(language => renderer(view, text => translateNative(text, language)));
/** Create presentation copies only. The reviewed object and digest remain untouched. */
export function settlementDisplay(review) {
  const checks = checkDisplay;
  return jsonUi({ ...review, summary: nativeText(review.summary), preflight: { ...review.preflight,
    checks: checks(review.preflight.checks), blocking: checks(review.preflight.blocking), unverifiable: checks(review.preflight.unverifiable),
    consequences: review.preflight.consequences.map(nativeText) } });
}
export function clearingDisplay(observation) {
  if (!observation?.view) return jsonUi(observation);
  const view = observation.view;
  return jsonUi({ ...observation, notes: typeof observation.notes === 'string' ? trustedMessage(observation.notes) : observation.notes, view: { ...view, headline: nativeText(view.headline), meaning: nativeText(view.meaning), action: nativeText(view.action),
    ...(view.provisionalNote === undefined ? {} : { provisionalNote: nativeText(view.provisionalNote) }) } });
}

export const checkDisplay = values => values.map(check => ({ ...check, name: nativeText(check.name), detail: nativeText(check.detail) }));

/** First-party review guidance only; original canonical facts JSON is not changed. */
export function clearingReviewDisplay(review, notes) {
  const facts = JSON.parse(review.facts), displayFacts = { ...facts };
  for (const key of ['approval', 'condition', 'holderRead']) if (typeof facts[key] === 'string') displayFacts[key] = nativeText(facts[key]);
  return jsonUi({ ...review, facts: displayFacts, notes: trustedMessage(notes) });
}
