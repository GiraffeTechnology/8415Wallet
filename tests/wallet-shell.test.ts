import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as i18n from '../web/i18n.mjs';
const source = readFileSync(new URL('../web/wallet-shell.mjs', import.meta.url), 'utf8').replace(/^import[^\n]*\n/gm, '');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
class Node {
  id = ''; dataset: Record<string, string> = {}; attributes = new Map<string, string>(); handlers = new Map<string, Function[]>();
  hidden = false; disabled = false; checked = false; value = ''; textContent = ''; children: Node[] = []; files: any[] = []; className = ''; focused = false;
  classList = { toggle() {} };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, fn: Function) { this.handlers.set(name, [...this.handlers.get(name) ?? [], fn]); }
  dispatchEvent(event: any) { for (const fn of this.handlers.get(event.type) ?? []) fn(event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  focus() { this.focused = true; }
  replaceChildren(...items: Node[]) { this.children = items; this.textContent = ''; }
  append(...items: Node[]) { this.children.push(...items); }
}
function fixture(linked = false) {
  const nodes: Node[] = [], ids = new Map<string, Node>(), events = new Node(), windowEvents = new Node();
  for (const tag of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]+)>/g)) {
    const node = new Node();
    for (const match of tag[2]!.matchAll(/([\w-]+)="([^"]*)"/g)) { const [, key, value] = match; node.setAttribute(key!, value!); if (key === 'id') { node.id = value!; ids.set(value!, node); } if (key === 'class') node.className = value!; if (key?.startsWith('data-')) node.dataset[key.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase())] = value!; }
    node.hidden = /(?:^|\s)hidden(?:\s|$)/.test(tag[2]!); nodes.push(node);
  }
  ids.get('wallet-login-method')!.value = 'wallet-local';
  const match = (node: Node, selector: string) => {
    const cls = selector.match(/^\.([\w-]+)/)?.[1]; if (cls && !node.className.split(' ').includes(cls)) return false;
    const attrs = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]+)")?\]/g)];
    return attrs.every(([, key, value]) => node.attributes.has(key!) && (value === undefined || node.attributes.get(key!) === value));
  };
  const document = { body: new Node(), getElementById: (id: string) => ids.get(id), createElement: () => new Node(), querySelectorAll: (selector: string) => nodes.filter(node => match(node, selector)), querySelector: (selector: string) => nodes.find(node => match(node, selector)), addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) };
  let subscriber: Function = () => {}, busy = false, avatarSaves = 0;
  const history: any[] = [];
  const profile = { id: linked ? 'v3' : 'v2', tenant: { id: 'xiongan', label: 'Xiongan' }, features: { linkedResponsibilities: linked } };
  class Avatar {
    state = { status: 'empty', savedUrl: null, previewUrl: null, errorCode: null, hasDraft: false, hasSaved: false };
    snapshot() { return this.state; } cancel() { this.state.hasDraft = false; return this.state; } setContext() {} async load() {} async select() {} async save() { avatarSaves++; } async remove() {} dispose() {}
  }
  const sdk = { ...i18n, walletLogin: { subscribe(fn: Function) { subscriber = fn; } }, getReleaseProfile: async () => profile, walletUiBusy: () => busy, TenantAvatarController: Avatar };
  const window = { location: { origin: 'http://localhost:18428', href: 'http://localhost:18428/web/index.html' }, history: { replaceState(s: any) { history.push(['replace', s]); }, pushState(s: any) { history.push(['push', s]); } }, addEventListener: windowEvents.addEventListener.bind(windowEvents) };
  new Function('document', 'globalThis', ...Object.keys(sdk), source)(document, window, ...Object.values(sdk));
  const el = (id: string) => ids.get(id)!;
  el('asset-dismiss').addEventListener('click', () => { el('asset-ack').checked = false; events.dispatchEvent({ type: 'wallet:asset-review-cleared' }); });
  return { el, nodes, events, windowEvents, history, profile, login: (session: any) => subscriber(session), setBusy: (value: boolean) => { busy = value; }, avatarSaves: () => avatarSaves, route: (name: string) => nodes.find(node => node.dataset.route === name)!.click(), page: (name: string) => nodes.find(node => node.dataset.page === name)! };
}
test('approved shell preserves exact original giraffe bytes, local asset references and all operational IDs', () => {
  assert.equal(createHash('sha256').update(readFileSync(new URL('../web/assets/giraffe-original.jpg', import.meta.url))).digest('hex'), '08f239d0eebdd0aa2b8fe09345c50297405db8e2345fa7304b205b65ad126c3c');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]); assert.equal(new Set(ids).size, ids.length);
  for (const id of ['wallet-private', 'asset-heading', 'asset-prepare', 'asset-send', 'asset-ack', 'settlement-prepare', 'settlement-send', 'deployment', 'standalone', 'linked', 'agent-controls-panel', 'legacy-clearing-panel', 'result']) assert.ok(ids.includes(id));
  assert.match(html, /id="wallet-private" hidden inert/); assert.doesNotMatch(html, /https:\/\/www\.figma\.com\/api\/mcp\/asset|SUPERSEDED|Giraffe-Redrawn/);
});
test('logged-out navigation cannot authenticate or display account facts; linked stays release-gated', async () => {
  const f = fixture(); await new Promise(resolve => setImmediate(resolve)); f.login(null); f.route('linked');
  assert.equal(f.el('wallet-private').hidden, true); assert.equal(f.el('shell-account').textContent, 'Signed out'); assert.equal(f.page('linked').hidden, true);
  f.login({ account: '0xowner', chainId: '1' }); assert.equal(f.page('overview').hidden, false); assert.equal(f.el('shell-account').textContent, '0xowner');
  f.route('linked'); assert.equal(f.page('linked').hidden, true); f.login(null); assert.equal(f.el('shell-account').textContent, 'Signed out');
});
test('native summary preserves owner/holder, contract finality and gap independence; errors clear cached facts', () => {
  const f = fixture(); f.login({ account: '0xaccount', chainId: '1' });
  f.events.dispatchEvent({ type: 'wallet:native-view', detail: { state: 'ready', view: { tokenId: 8415n, tradeablePosition: { owner: 'OWNER' }, confirmedHolder: { holder: 'HOLDER', version: 3n }, presentFinality: { final: false }, gap: { kind: 'none' }, observedAt: 99n } } });
  assert.equal(f.el('native-owner').textContent, 'OWNER'); assert.equal(f.el('native-holder').textContent, 'HOLDER'); assert.equal(f.el('native-finality').textContent, 'Provisional'); assert.equal(f.el('native-gap').textContent, 'No open gap'); assert.equal(f.el('native-freshness').textContent, 'Freshness not read');
  f.events.dispatchEvent({ type: 'wallet:native-view', detail: { state: 'error' } }); assert.equal(f.el('native-owner').textContent, '—'); assert.equal(f.el('native-holder').textContent, '—');
  f.login(null); f.events.dispatchEvent({ type: 'wallet:native-view', detail: { state: 'ready', view: {} } }); assert.equal(f.el('native-owner').textContent, '—');
});
test('review screen shows full immutable fields and Escape invalidates the acknowledgement', () => {
  const f = fixture(); f.login({ account: 'ACCOUNT', chainId: '1' });
  f.events.dispatchEvent({ type: 'wallet:asset-review', detail: { amount: '1000000000000001', asset: 'ETH', recipient: 'FULL_RECIPIENT', chain: 'Ethereum', tokenId: null, transaction: { from: 'FULL_ACCOUNT', to: 'FULL_RECIPIENT' } } });
  assert.equal(f.page('review').hidden, false); assert.equal(f.el('transfer-review-summary').children[0]!.textContent, '1000000000000001 wei');
  f.el('asset-ack').checked = true; f.windowEvents.dispatchEvent({ type: 'keydown', key: 'Escape' }); assert.equal(f.el('asset-ack').checked, false); assert.equal(f.page('transfer').hidden, false); assert.equal(f.el('transfer-review-summary').children.length, 0);
});
test('navigation does not bypass in-flight UI lock, and Back cannot activate disabled V3 controls', async () => {
  const f = fixture(); await new Promise(resolve => setImmediate(resolve)); f.login({ account: 'ACCOUNT', chainId: '1' }); f.setBusy(true); f.route('activity'); assert.equal(f.page('overview').hidden, false);
  f.setBusy(false); f.windowEvents.dispatchEvent({ type: 'popstate', state: { walletPage: 'linked' } }); assert.equal(f.page('linked').hidden, true);
});
test('Back dismisses review without overwriting the target history entry', () => {
  const f = fixture(); f.login({ account: 'ACCOUNT', chainId: '1' });
  f.events.dispatchEvent({ type: 'wallet:asset-review', detail: { amount: '1', asset: 'ETH', recipient: 'RECIPIENT', chain: 'Ethereum', tokenId: null, transaction: { from: 'ACCOUNT', to: 'RECIPIENT' } } });
  f.el('asset-ack').checked = true; const before = f.history.length;
  f.windowEvents.dispatchEvent({ type: 'popstate', state: { walletPage: 'overview' } });
  assert.equal(f.page('overview').hidden, false); assert.equal(f.el('asset-ack').checked, false); assert.equal(f.history.length, before);
});
test('anomalous present-finality true never paints a green settled badge', () => {
  const f = fixture(); f.login({ account: 'ACCOUNT', chainId: '1' });
  f.events.dispatchEvent({ type: 'wallet:native-view', detail: { state: 'ready', view: { tokenId: 1n, tradeablePosition: { owner: 'SAME' }, confirmedHolder: { holder: 'SAME', version: 3n }, presentFinality: { final: true }, gap: { kind: 'none' }, observedAt: 99n } } });
  assert.match(f.el('native-finality').textContent, /protocol inconsistency/); assert.equal(f.el('native-finality').className, 'badge danger'); assert.match(f.el('native-status').textContent, /contrary to the protocol rule/);
});
test('BFCache restoration creates a usable new avatar controller', async () => {
  const f = fixture(); await new Promise(resolve => setImmediate(resolve)); f.windowEvents.dispatchEvent({ type: 'pagehide' }); f.windowEvents.dispatchEvent({ type: 'pageshow', persisted: true }); await new Promise(resolve => setImmediate(resolve));
  assert.match(f.el('tenant-avatar-status').textContent, /empty/);
});
test('every moved settlement and destination input remains covered by logout reset', () => {
  const app = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8');
  assert.match(html, /id="settlement-panel" data-page="settlement"/); assert.match(html, /id="account-panel" data-page="account"/);
  assert.match(app, /#settlement-panel input, #account-panel input/);
});
test('transaction initiation invalidates native, NFT and ETH summaries instead of preserving stale facts', () => {
  const f = fixture(); f.login({ account: 'ACCOUNT', chainId: '1' });
  f.el('native-owner').textContent = 'OLD_OWNER'; f.el('native-holder').textContent = 'OLD_HOLDER'; f.el('shell-balance').textContent = '1 ETH';
  f.events.dispatchEvent({ type: 'wallet:summary-stale' });
  assert.equal(f.el('native-owner').textContent, '—'); assert.equal(f.el('native-holder').textContent, '—'); assert.equal(f.el('shell-balance').textContent, 'No external-account balance read yet'); assert.equal(f.el('nft-overview').children[0]!.textContent, 'No NFT holding read yet');
  const app = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8'); const external = readFileSync(new URL('../web/external-assets.mjs', import.meta.url), 'utf8');
  assert.equal((app.match(/new CustomEvent\('wallet:summary-stale'\)/g) ?? []).length, 4);
  assert.match(app, /wallet:summary-stale[\s\S]*?s\.execute\(/);
  assert.match(app, /wallet:summary-stale[\s\S]*?s\.submit\(/);
  const clearing = readFileSync(new URL('../web/legacy-clearing.mjs', import.meta.url), 'utf8');
  assert.match(clearing, /wallet:summary-stale[\s\S]*?selected\(\)\.submit\(/);
  assert.doesNotMatch(external, /const current = generation;\s*document\.dispatchEvent/);
  assert.match(external, /el\('asset-balance'\)[\s\S]*?detail: 'eth'/);
  assert.match(external, /el\('asset-send'\)\.addEventListener\('click',[\s\S]*?wallet:summary-stale[\s\S]*?s\.submit\(/);
});
test('NFT transfer preparation preserves the chosen standard and exact inspected input pair', () => {
  const f = fixture(); f.login({ account: 'ACCOUNT', chainId: '1' });
  f.el('nft-standard').value = 'ERC-1155'; f.el('nft-contract').value = 'EXACT_CONTRACT'; f.el('nft-token-id').value = '12';
  f.nodes.find(node => node.dataset.nftTransfer === 'true')!.click();
  assert.equal(f.el('asset-kind').value, 'erc1155-transfer'); assert.equal(f.el('asset-contract').value, 'EXACT_CONTRACT'); assert.equal(f.el('asset-token-id').value, '12'); assert.equal(f.page('transfer').hidden, false);
});
test('read refreshes invalidate only their own surface so native, NFT and ETH observations coexist', () => {
  const f = fixture(); f.login({ account: 'ACCOUNT', chainId: '1' });
  f.el('native-owner').textContent = 'OWNER'; f.el('native-holder').textContent = 'HOLDER'; f.el('shell-balance').textContent = '1 ETH';
  f.events.dispatchEvent({ type: 'wallet:nft-view', detail: { standard: 'ERC-1155', tokenId: '12', balanceRaw: '3', contract: 'CONTRACT' } });
  assert.equal(f.el('native-owner').textContent, 'OWNER'); assert.equal(f.el('shell-balance').textContent, '1 ETH');
  f.events.dispatchEvent({ type: 'wallet:summary-stale', detail: 'eth' });
  assert.equal(f.el('native-owner').textContent, 'OWNER'); assert.equal(f.el('nft-overview').children[0]!.textContent, 'ERC-1155 #12');
  f.events.dispatchEvent({ type: 'wallet:asset-balance', detail: { balanceETH: '2' } });
  f.events.dispatchEvent({ type: 'wallet:native-view', detail: { state: 'loading' } });
  assert.equal(f.el('shell-balance').textContent, '2 ETH'); assert.equal(f.el('nft-overview').children[0]!.textContent, 'ERC-1155 #12');
});
