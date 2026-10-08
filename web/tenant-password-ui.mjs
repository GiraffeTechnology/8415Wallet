/** Platform-only public tenant selection. No cross-origin capability/login requests. */
import { getReleaseProfile } from './release-profile.mjs';
import { isPlatformPasswordProfile, loadPasswordRoutes, passwordTenantDestination } from './tenant-password-routing.mjs';
import { msg, paint } from './i18n.mjs';
import { walletUiBusy } from './ui-lock.mjs';
const el = id => document.getElementById(id);
let routes = null;
function render() {
  const link = el('password-tenant-continue');
  link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true');
  try {
    if (!routes) throw Error('PASSWORD_ROUTING_UNAVAILABLE');
    link.href = passwordTenantDestination(routes, el('password-tenant-select').value, el('password-tenant-action').value);
    link.setAttribute('aria-disabled', 'false');
    paint(el('password-tenant-status'), msg('account.tenantPasswordReady'));
  } catch {
    paint(el('password-tenant-status'), msg('account.tenantPasswordPending'));
  }
}
el('password-tenant-select').addEventListener('change', render);
el('password-tenant-action').addEventListener('change', render);
el('password-tenant-continue').addEventListener('click', event => {
  if (walletUiBusy() || !el('password-tenant-continue').hasAttribute('href')) event.preventDefault();
});
getReleaseProfile().then(async profile => {
  if (!isPlatformPasswordProfile(profile)) return;
  el('platform-password-tenants').hidden = false; render();
  try { routes = await loadPasswordRoutes(); } catch { routes = null; }
  render();
}).catch(() => { /* Unverified platform profile has no navigation authority. */ });
