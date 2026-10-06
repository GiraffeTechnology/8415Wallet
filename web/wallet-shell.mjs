/** Approved Figma presentation. No signing, RPC, custody or authentication authority. */
import { msg, paint } from './i18n.mjs';
import { walletLogin } from './wallet-auth.mjs';
import { getReleaseProfile } from './release-profile.mjs';
import { walletUiBusy } from './ui-lock.mjs';
import { TenantAvatarController } from './tenant-avatar.mjs';
const el = id => document.getElementById(id);
const pages = new Set(['overview', 'native', 'settlement', 'account', 'transfer', 'review', 'receive', 'activity', 'nft', 'linked', 'advanced', 'settings']);
const titles = { overview: 'overview', native: 'native', settlement: 'settlement', account: 'standalone', transfer: 'send', review: 'review', receive: 'receive', activity: 'activity', nft: 'nftDetails', linked: 'responsibilities', advanced: 'advanced', settings: 'settings' };
let page = 'overview', authenticated = false, profile = null, avatarGeneration = 0, navigationDismiss = false;
let avatar = new TenantAvatarController();
function resetNative(state = 'notRead') {
  for (const id of ['native-token', 'native-entry', 'native-finality', 'native-contested', 'native-gap', 'native-freshness']) paint(el(id), '');
  for (const id of ['native-owner', 'native-holder']) paint(el(id), '—');
  paint(el('native-status'), msg(`design.${state}`));
}
function dismissReview() { if (page !== 'review') return; navigationDismiss = true; try { el('asset-dismiss').click(); } finally { navigationDismiss = false; } }
function route(next, { history = true, focus = true } = {}) {
  if (!pages.has(next)) next = 'overview';
  if (next === 'linked' && !profile?.features.linkedResponsibilities) next = 'overview';
  if (page !== next) { dismissReview(); avatarGeneration++; avatar.cancel(); renderAvatar(); }
  page = next;
  for (const node of document.querySelectorAll('[data-page]')) node.hidden = node.dataset.page !== page;
  el('external-pages').hidden = !['transfer', 'review', 'receive', 'activity', 'nft'].includes(page);
  el('login-panel').hidden = authenticated && page !== 'settings';
  // Native mode is retained by the original adapter; this router only chooses its screen.
  el('standalone').hidden = page !== 'native';
  el('read-result-card').hidden = !authenticated || !['native', 'settlement', 'account', 'linked'].includes(page);
  for (const node of document.querySelectorAll('.nav-item')) {
    const active = node.dataset.route === page || (node.dataset.route === 'native' && ['nft', 'settlement', 'account'].includes(page)) || (node.dataset.route === 'overview' && ['transfer', 'review', 'receive'].includes(page));
    if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  }
  paint(el('page-title'), msg(authenticated ? `design.${titles[page]}` : 'ui.005'));
  paint(el('page-description'), authenticated && page === 'overview' ? msg('design.overviewNote') : '');
  if (history) globalThis.history.replaceState({ walletPage: page }, '');
  if (focus) el('page-title').focus({ preventScroll: true });
}
for (const button of document.querySelectorAll('[data-route]')) button.addEventListener('click', () => {
  if (walletUiBusy()) return;
  const next = button.dataset.route;
  if (page === 'settings' && page !== next) document.dispatchEvent(new CustomEvent('wallet:authentication-leaving'));
  if (authenticated && next !== page) globalThis.history.pushState({ walletPage: next }, '');
  if (button.dataset.settlement) {
    el('settlement-kind').value = button.dataset.settlement;
    el('settlement-kind').dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (button.dataset.nftTransfer) {
    el('asset-kind').value = el('nft-standard').value === 'ERC-1155' ? 'erc1155-transfer' : 'erc721-transfer';
    el('asset-contract').value = el('nft-contract').value; el('asset-token-id').value = el('nft-token-id').value;
    el('asset-kind').dispatchEvent(new Event('change', { bubbles: true }));
  }
  route(next);
});
el('skip-content').addEventListener('click', () => el('page-title').focus());
globalThis.addEventListener('keydown', event => { if (event.key !== 'Escape' || walletUiBusy()) return; if (page === 'review') el('asset-dismiss').click(); else if (page === 'settings') { avatarGeneration++; avatar.cancel(); el('tenant-avatar-file').value = ''; renderAvatar(); } });
globalThis.addEventListener('popstate', event => { if (walletUiBusy()) { globalThis.history.replaceState({ walletPage: page }, ''); return; } route(event.state?.walletPage, { history: false }); });
el('asset-dismiss').addEventListener('click', () => { if (page === 'review' && !navigationDismiss) { page = 'transfer'; route('transfer'); } });
document.addEventListener('wallet:asset-review', event => {
  if (!authenticated) return;
  const value = event.detail, summary = el('transfer-review-summary'); summary.replaceChildren();
  const title = document.createElement('h2'); title.textContent = `${value.amount} ${value.asset === 'ETH' ? 'wei' : value.asset}`; summary.append(title);
  const fields = [['ui.040', value.asset], ['ui.045', value.recipient], ['design.externalAccount', value.transaction.from], ['design.network', value.chain], ['ui.047', value.transaction.to], ['ui.050', value.tokenId ?? '—']];
  for (const [key, content] of fields) { const row = document.createElement('div'); row.className = 'review-row'; const label = document.createElement('span'); paint(label, msg(key)); const data = document.createElement('strong'); data.textContent = content; row.append(label, data); summary.append(row); }
  route('review');
});
document.addEventListener('wallet:asset-review-cleared', () => el('transfer-review-summary').replaceChildren());
document.addEventListener('wallet:summary-stale', event => {
  const scope = event.detail ?? 'all';
  if (scope === 'all' || scope === 'native') resetNative();
  if (['all', 'external', 'eth'].includes(scope)) paint(el('shell-balance'), msg('design.balanceUnread'));
  if (['all', 'external', 'nft'].includes(scope)) {
    paint(el('nft-result'), msg('design.noNft'));
    document.dispatchEvent(new CustomEvent('wallet:nft-view', { detail: null }));
  }
});
document.addEventListener('wallet:nft-view', event => {
  const card = el('nft-overview'); card.replaceChildren();
  if (!authenticated || !event.detail) { const title = document.createElement('strong'); paint(title, msg('design.noNft')); const note = document.createElement('p'); paint(note, msg('design.exactNft')); card.append(title, note); return; }
  const value = event.detail, title = document.createElement('strong'), body = document.createElement('p');
  title.textContent = `${value.standard} #${value.tokenId}`;
  body.textContent = `${value.balanceRaw} · ${value.contract}`; card.append(title, body);
});
document.addEventListener('wallet:asset-balance', event => { if (authenticated) paint(el('shell-balance'), `${event.detail.balanceETH} ETH`); });
document.addEventListener('wallet:native-view', event => {
  if (!authenticated) return;
  const { state, view } = event.detail;
  if (state !== 'ready') { resetNative(state === 'loading' ? 'loading' : state === 'error' ? 'readFailed' : 'notRead'); return; }
  paint(el('native-token'), `#${view.tokenId}`);
  paint(el('native-owner'), view.tradeablePosition.owner);
  paint(el('native-holder'), view.confirmedHolder.holder);
  paint(el('native-entry'), msg('design.entry', { version: view.confirmedHolder.version }));
  paint(el('native-finality'), msg(view.presentFinality.final ? 'design.finalityAnomaly' : 'design.provisional'));
  el('native-finality').className = `badge ${view.presentFinality.final ? 'danger' : 'warning'}`;
  paint(el('native-gap'), msg(view.gap.kind === 'open' ? 'design.openGap' : view.gap.kind === 'none' ? 'design.closedGap' : 'design.noSettlement'));
  el('native-gap').className = `badge ${view.gap.kind === 'open' ? 'warning' : ''}`;
  paint(el('native-contested'), view.gap.kind === 'open' ? msg('design.contestedFrom', { instant: view.gap.openedAt }) : msg(view.gap.kind === 'none' ? 'design.notContested' : 'design.noSettlement'));
  el('native-contested').className = `badge ${view.gap.kind === 'open' ? 'danger' : ''}`;
  paint(el('native-freshness'), msg('design.freshnessUnread'));
  paint(el('native-status'), view.presentFinality.final ? msg('design.finalityAnomalyNote') : msg('design.snapshot', { instant: view.observedAt }));
});
walletLogin.subscribe(session => {
  authenticated = !!session;
  document.body.classList.toggle('signed-out', !authenticated);
  paint(el('shell-account'), session ? session.account : msg('design.signedOut'));
  paint(el('shell-chain'), session ? `Chain ${session.chainId}` : '');
  if (!session) { resetNative(); paint(el('shell-balance'), msg('design.balanceUnread')); paint(el('native-read-result'), ''); }
  route(session ? 'overview' : 'settings', { focus: false });
});
function avatarImage(target, url) {
  target.replaceChildren();
  if (url) { const image = document.createElement('img'); image.src = url; image.alt = ''; target.append(image); }
  else target.textContent = profile?.tenant.label?.slice(0, 1) || '8';
}
function renderAvatar() {
  const state = avatar.snapshot();
  avatarImage(el('tenant-avatar'), state.savedUrl);
  avatarImage(el('tenant-avatar-preview'), state.previewUrl ?? state.savedUrl);
  paint(el('tenant-avatar-status'), msg('design.avatarStatus', { status: state.errorCode ?? state.status }));
  el('tenant-avatar-save').disabled = !state.hasDraft;
  el('tenant-avatar-remove').disabled = !state.hasSaved;
}
async function changeAvatar(action) {
  const generation = ++avatarGeneration;
  try { await action(); } catch { /* Render only the controller's stable public status. */ }
  if (generation === avatarGeneration) renderAvatar();
}
el('tenant-avatar-file').addEventListener('change', () => {
  const file = el('tenant-avatar-file').files?.[0];
  if (file) changeAvatar(() => avatar.select(file));
});
el('tenant-avatar-save').addEventListener('click', () => changeAvatar(() => avatar.save()));
el('tenant-avatar-cancel').addEventListener('click', () => { avatarGeneration++; avatar.cancel(); el('tenant-avatar-file').value = ''; renderAvatar(); });
el('tenant-avatar-remove').addEventListener('click', () => changeAvatar(() => avatar.remove()));
globalThis.addEventListener('pagehide', () => { avatarGeneration++; avatar.dispose(); });
globalThis.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  avatarGeneration++; avatar = new TenantAvatarController();
  if (profile) { try { avatar.setContext(profile, globalThis.location); changeAvatar(() => avatar.load()); } catch { renderAvatar(); } }
});
getReleaseProfile().then(async value => {
  profile = value; paint(el('tenant-label'), value.tenant.label);
  el('profile-name').value = value.tenant.label; el('profile-tenant').value = value.tenant.id; el('profile-version').value = value.id.toUpperCase();
  paint(el('tenant-context'), msg('design.workspace', { profile: value.id.toUpperCase() }));
  document.querySelector('.nav-item[data-route="linked"]').hidden = !value.features.linkedResponsibilities;
  try { avatar.setContext(value, globalThis.location); await avatar.load(); } catch { /* Storage unavailable is a visible local preference failure only. */ }
  renderAvatar(); route(page, { focus: false });
}).catch(() => { for (const button of document.querySelectorAll('[data-route]')) button.disabled = true; });
for (const button of document.querySelectorAll('[data-login-method]')) button.addEventListener('click', () => {
  el('wallet-login-method').value = button.dataset.loginMethod; el('wallet-login-method').dispatchEvent(new Event('change', { bubbles: true }));
});
function loginMethod() { for (const button of document.querySelectorAll('[data-login-method]')) button.setAttribute('aria-pressed', String(button.dataset.loginMethod === el('wallet-login-method').value)); }
el('wallet-login-method').addEventListener('change', loginMethod);
document.addEventListener('wallet:authentication-method', loginMethod);
document.addEventListener('wallet:authentication-settings', () => route('settings'));
loginMethod();
resetNative(); route('overview', { focus: false });
