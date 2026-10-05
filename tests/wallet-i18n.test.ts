import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATALOGS, LOCALES, t, msg, jsonUi, renderUi, paint, setLocale, normalizeLocale, initializeLocale, LOCALE_STORAGE_KEY, formatDisplayDecimal, decimalUi } from '../web/i18n.mjs';
const parameters = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match => match[1]).sort();

test('six fixed catalogs have exact key and placeholder parity, complete translated disclosures', () => {
  const english = CATALOGS.en!;
  assert.deepEqual(LOCALES.map(item => item.id), ['en', 'zh-Hans', 'zh-Hant', 'fr', 'es', 'ja']);
  assert.deepEqual(LOCALES.map(item => item.label), ['EN', '简', '繁', 'FR', 'ES', '日']);
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), locale);
    for (const [key, text] of Object.entries(catalog)) {
      assert.ok(text.trim().length > 0, `${locale}/${key}`);
      assert.deepEqual(parameters(text), parameters(english[key]!), `${locale}/${key}`);
      if (locale !== 'en' && text === english[key]) assert.ok((['ui.043', 'ui.044'].includes(key) || (locale === 'fr' && ['locale.mode', 'protocol.189', 'protocol.245', 'protocol.252'].includes(key)) || (locale === 'es' && ['protocol.022', 'protocol.024', 'protocol.181', 'protocol.252'].includes(key))), `Untranslated ${locale}/${key}`);
    }
  }
});
test('unsupported or corrupt preferences fall back to English without reading browser language', () => {
  for (const value of [null, undefined, '', 'de', 'zh', '__proto__', {}, '<script>']) assert.equal(normalizeLocale(value), 'en');
  assert.throws(() => t('missing.key'), /UI_MESSAGE_KEY_UNKNOWN/);
  assert.throws(() => t('status.identity'), /UI_MESSAGE_PARAMETER_MISSING/);
  assert.equal(t('ui.005', {}, 'invalid'), CATALOGS.en!['ui.005']);
});
test('only preference is persisted; blocked storage still switches locally and sets html lang', () => {
  const writes: any[] = [], document = { documentElement: { lang: '' }, querySelectorAll: () => [] };
  const storage = { getItem: () => 'ja', setItem: (...args: any[]) => writes.push(args) };
  initializeLocale(document, storage); assert.equal(document.documentElement.lang, 'ja'); assert.deepEqual(writes, []);
  setLocale('zh-Hant', { document, storage }); assert.equal(document.documentElement.lang, 'zh-Hant'); assert.deepEqual(writes, [[LOCALE_STORAGE_KEY, 'zh-Hant']]);
  setLocale('fr', { document, storage: { setItem() { throw Error('blocked'); } } }); assert.equal(document.documentElement.lang, 'fr');
  initializeLocale(document, { getItem() { throw Error('blocked'); } }); assert.equal(document.documentElement.lang, 'en');
});
test('untrusted token strings and JSON marker lookalikes are never translated or interpreted as markup', () => {
  const raw = { name: 'Password', symbol: 'FR', description: '<img src=x onerror=alert(1)> {account} 原碼', metadata: { key: 'ui.005', parameters: {} },
    amount: '1000000000000000001', address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', protocol: 'finalizeSettlement' };
  const before = JSON.stringify(raw), document = jsonUi({ ...raw, caution: msg('message.029') });
  for (const locale of LOCALES) {
    const rendered = JSON.parse(renderUi(document, locale.id));
    for (const [key, value] of Object.entries(raw)) assert.deepEqual(rendered[key], value);
    assert.equal(rendered.caution, t('message.029', {}, locale.id));
  }
  assert.equal(JSON.stringify(raw), before);
  assert.equal(renderUi('<b>原碼</b>', 'fr'), '<b>原碼</b>');
  assert.equal(renderUi(msg('status.identity', { chain: '1', account: '{chain}<script>' }), 'en'), 'Chain 1 · selected account {chain}<script>');
});
test('language switch updates presentation without changing inputs, consent, hidden state or callbacks', () => {
  let calls = 0;
  const node = { textContent: '', value: '1000000000000000001', checked: true, hidden: true, inert: true,
    removeAttribute() {}, addEventListener() { calls++; }, click() { calls++; } };
  paint(node, msg('message.014'));
  for (const locale of LOCALES) {
    setLocale(locale.id, { persist: false }); assert.equal(node.textContent, t('message.014'));
    assert.equal(node.value, '1000000000000000001'); assert.equal(node.checked, true); assert.equal(node.hidden, true); assert.equal(node.inert, true);
  }
  assert.equal(calls, 0); setLocale('en', { persist: false });
});
test('clearing auth and private text also clears its language binding; switching never revives a secret', () => {
  const node = { textContent: '', removeAttribute() {} };
  paint(node, msg('auth.setupSecret', { secret: 'SYNTHETIC_ONLY', uri: 'otpauth://test', expires: '2030-01-01T00:00:00.000Z' }));
  assert.match(node.textContent, /SYNTHETIC_ONLY/); paint(node, '');
  for (const locale of LOCALES) { setLocale(locale.id, { persist: false }); assert.equal(node.textContent, ''); }
  setLocale('en', { persist: false });
});
test('all explicit static UI keys exist; selector has compact labels and native accessible names', () => {
  for (const file of ['index.html', 'legacy-clearing.mjs']) {
    const source = readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)) assert.ok(Object.hasOwn(CATALOGS.en!, match[1]!), match[1]);
  }
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const { id, label, name } of LOCALES) assert.match(html, new RegExp(`data-ui-locale="${id}" lang="${id}" aria-label="${name}"[^>]*>${label}</button>`));
  assert.match(html, /id="wallet-private" hidden inert/);
  const code = readFileSync(new URL('../web/i18n.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\.innerHTML\s*=|\.value\s*=|\.checked\s*=|\.hidden\s*=|\.inert\s*=|fetch\(|ethereum|eth_sendTransaction|personal_sign/);
});

test('localized decimal display preserves every digit without changing raw transaction integers', () => {
  const raw = '123456789012345678901234567890.000000000000000001';
  assert.equal(formatDisplayDecimal(raw, 'es'), '123.456.789.012.345.678.901.234.567.890,000000000000000001');
  assert.equal(formatDisplayDecimal(raw, 'en'), '123,456,789,012,345,678,901,234,567,890.000000000000000001');
  const document = jsonUi({ amount: '123456789012345678901234567890000000000000000001', humanAmount: msg('amount.tokenUnits', { amount: decimalUi(raw) }) });
  const result = JSON.parse(renderUi(document, 'fr'));
  assert.equal(result.amount, '123456789012345678901234567890000000000000000001');
  assert.match(result.humanAmount, /,000000000000000001/);
  for (const invalid of ['1e18', '-1', '1,2', 'NaN', '01']) assert.throws(() => formatDisplayDecimal(invalid), /UI_DECIMAL_REFUSED/);
});
