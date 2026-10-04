/** Local presentation only. No provider, authentication, network or transaction calls. */
import en from './locales/en.mjs';
import design from './locales/design.mjs';
import hans from './locales/zh-Hans.mjs';
import hant from './locales/zh-Hant.mjs';
import fr from './locales/fr.mjs';
import es from './locales/es.mjs';
import ja from './locales/ja.mjs';
import nativeFragments from './locales/native-fragments.mjs';
import native0 from './locales/native-en.mjs';
import native1 from './locales/native-zh-Hans.mjs';
import native2 from './locales/native-zh-Hant.mjs';
import native3 from './locales/native-fr.mjs';
import native4 from './locales/native-es.mjs';
import native5 from './locales/native-ja.mjs';

export const CATALOGS = Object.freeze({ en: Object.freeze({ ...en, ...native0, ...nativeFragments['en'], ...design['en'] }), 'zh-Hans': Object.freeze({ ...hans, ...native1, ...nativeFragments['zh-Hans'], ...design['zh-Hans'] }), 'zh-Hant': Object.freeze({ ...hant, ...native2, ...nativeFragments['zh-Hant'], ...design['zh-Hant'] }), fr: Object.freeze({ ...fr, ...native3, ...nativeFragments['fr'], ...design['fr'] }), es: Object.freeze({ ...es, ...native4, ...nativeFragments['es'], ...design['es'] }), ja: Object.freeze({ ...ja, ...native5, ...nativeFragments['ja'], ...design['ja'] }) });
export const LOCALES = Object.freeze([
  Object.freeze({ id: 'en', label: 'EN', name: 'English' }),
  Object.freeze({ id: 'zh-Hans', label: '简', name: '简体中文' }),
  Object.freeze({ id: 'zh-Hant', label: '繁', name: '繁體中文' }),
  Object.freeze({ id: 'fr', label: 'FR', name: 'Français' }),
  Object.freeze({ id: 'es', label: 'ES', name: 'Español' }),
  Object.freeze({ id: 'ja', label: '日', name: '日本語' }),
]);
export const LOCALE_STORAGE_KEY = '8415wallet.ui.locale.v1';
export const normalizeLocale = value => typeof value === 'string' && Object.hasOwn(CATALOGS, value) ? value : 'en';
let locale = 'en';
const messages = new WeakSet(), documents = new WeakSet(), decimals = new WeakSet(), presentations = new WeakMap(), bindings = new Map();
export const getLocale = () => locale;
export function t(key, parameters = {}, language = locale) {
  const template = CATALOGS[normalizeLocale(language)][key] ?? CATALOGS.en[key];
  if (typeof template !== 'string') throw new Error(`UI_MESSAGE_KEY_UNKNOWN: ${key}`);
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_all, name) => {
    if (!Object.hasOwn(parameters, name)) throw new Error(`UI_MESSAGE_PARAMETER_MISSING: ${key}.${name}`);
    // Substitution happens once. Token-supplied braces and markup are always literal.
    return decimals.has(parameters[name]) ? formatDisplayDecimal(parameters[name].value, language) : String(parameters[name]);
  });
}
export function msg(key, parameters = {}) {
  if (!Object.hasOwn(CATALOGS.en, key)) throw new Error(`UI_MESSAGE_KEY_UNKNOWN: ${key}`);
  const value = Object.freeze({ key, parameters: Object.freeze({ ...parameters }) });
  messages.add(value); return value;
}
/** Marker identities cannot be forged by a JSON document or token metadata. */
export function jsonUi(value) {
  if (messages.has(value) || presentations.has(value)) return value;
  if (typeof value === 'string') return statusUi(value);
  const document = Object.freeze({ value }); documents.add(document); return document;
}
export function renderUi(value, language = locale) {
  if (presentations.has(value)) return presentations.get(value)(language);
  if (messages.has(value)) return t(value.key, value.parameters, language);
  if (documents.has(value)) return JSON.stringify(value.value, (_key, item) =>
    presentations.has(item) ? presentations.get(item)(language) : messages.has(item) ? t(item.key, item.parameters, language) : typeof item === 'bigint' ? item.toString() : item, 2);
  // Plain strings, token names, descriptions, addresses, IDs and signed terms stay exact.
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}
export function paint(element, value) {
  if (!element) return;
  // Clearing a node also removes any cached sensitive enrollment/recovery data.
  if (value === '' || value == null) bindings.delete(element); else bindings.set(element, value);
  element.textContent = renderUi(statusUi(value));
  // Initial static messages may later become dynamic. Never restore their stale text.
  element.removeAttribute?.('data-i18n');
}
export function statusUi(value) {
  return typeof value === 'string' && /^(?:AUTH|LOGIN|ASSET|CONTROL|CLEARING|COLLISION|SETTLEMENT)_[A-Z0-9_]+$/.test(value)
    ? msg('status.code', { code: value }) : value;
}
export function translateStatic(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  for (const element of root.querySelectorAll('[data-i18n]')) { const key = element.getAttribute?.('data-i18n'); if (key) element.textContent = t(key); }
  for (const element of root.querySelectorAll('[data-i18n-aria]')) { const key = element.getAttribute?.('data-i18n-aria'); if (key) element.setAttribute('aria-label', t(key)); }
}
export function setLocale(value, { document = globalThis.document, storage, persist = true } = {}) {
  locale = normalizeLocale(value);
  if (persist) { try { (storage ?? globalThis.localStorage)?.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Preference only; blocked storage is harmless. */ } }
  if (document?.documentElement) document.documentElement.lang = locale;
  translateStatic(document);
  for (const [element, content] of bindings) {
    if (element.isConnected === false) { bindings.delete(element); continue; }
    element.textContent = renderUi(statusUi(content));
  }
  for (const button of document?.querySelectorAll?.('[data-ui-locale]') ?? []) button.setAttribute('aria-pressed', String(button.getAttribute('data-ui-locale') === locale));
  return locale;
}
export function initializeLocale(document = globalThis.document, storage) {
  let stored = null;
  try { stored = (storage ?? globalThis.localStorage)?.getItem(LOCALE_STORAGE_KEY); } catch { /* English default. */ }
  setLocale(stored, { document, persist: false });
  for (const button of document?.querySelectorAll?.('[data-ui-locale]') ?? []) button.addEventListener('click', () => {
    setLocale(button.getAttribute('data-ui-locale'), { document, storage });
    const active = LOCALES.find(item => item.id === locale);
    const announcement = document.getElementById('locale-announcement');
    if (announcement) paint(announcement, msg('locale.changed', { language: active.name }));
  });
}

const trustedKeys = new Map(Object.entries(en).map(([key, value]) => [value, key]));
/** Only for first-party SDK disclosures, never token metadata or signed terms. */
export const trustedMessage = text => trustedKeys.has(text) ? msg(trustedKeys.get(text)) : text;

/** Decimal formatting is display-only: never convert transaction amounts to Number. */
export function formatDisplayDecimal(value, language = locale) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new Error('UI_DECIMAL_REFUSED');
  const [whole, fraction] = value.split('.');
  const formatter = new Intl.NumberFormat(normalizeLocale(language));
  const separator = formatter.formatToParts(1.1).find(part => part.type === 'decimal')?.value ?? '.';
  return formatter.format(BigInt(whole)) + (fraction === undefined ? '' : separator + fraction);
}
export function decimalUi(value) { const item = Object.freeze({ value }); decimals.add(item); return item; }

/** Internal presentation binding. Imported JSON cannot create a renderer marker. */
export function presentation(renderer) { const marker = Object.freeze({}); presentations.set(marker, renderer); return marker; }
