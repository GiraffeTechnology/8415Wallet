/** Public navigation hints only; never authentication or credential transport. */
const fail = code => { throw Error(code); };
const exact = (v, fields) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === fields.split(',').sort().join(',');
export const PASSWORD_TENANTS = Object.freeze(['xiongan', 'giraffe', 'lala']);
export const PASSWORD_PANELS = Object.freeze({ initial: '#auth-initial', manage: '#auth-manage' });
const tenantUrls = Object.freeze({
  xiongan: 'https://xiongan.8415wallet.com:9446/web/index.html',
  giraffe: 'https://giraffe.8415wallet.com:9446/web/index.html',
  lala: 'https://lala.8415wallet.com:9446/web/index.html'
});
export function passwordPanelAction(profile, location) {
  const action = Object.keys(PASSWORD_PANELS).find(key => PASSWORD_PANELS[key] === location.hash);
  if (!action || !PASSWORD_TENANTS.includes(profile.tenant.id) || profile.deployment.url !== tenantUrls[profile.tenant.id] ||
      profile.id !== (profile.tenant.id === 'xiongan' ? 'v2' : 'v3')) return null;
  const actual = new URL(location.href), expected = new URL(profile.deployment.url);
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search) return null;
  return action;
}
export function validatePasswordRoutes(value) {
  if (!exact(value, 'schema,entries') || value.schema !== '8415wallet-password-routing/1' ||
      !Array.isArray(value.entries) || value.entries.length !== PASSWORD_TENANTS.length) fail('PASSWORD_ROUTING_SCHEMA_REFUSED');
  const seen = new Set();
  const entries = value.entries.map(entry => {
    if (!exact(entry, 'tenant,profile,url,passwordManagementReady') ||
        !PASSWORD_TENANTS.includes(entry.tenant) || seen.has(entry.tenant) ||
        entry.profile !== (entry.tenant === 'xiongan' ? 'v2' : 'v3') ||
        typeof entry.passwordManagementReady !== 'boolean') fail('PASSWORD_ROUTING_TENANT_REFUSED');
    seen.add(entry.tenant);
    if (entry.url === null) {
      if (entry.passwordManagementReady) fail('PASSWORD_ROUTING_NOT_DEPLOYED');
    } else {
      if (typeof entry.url !== 'string' || entry.url.length > 2048) fail('PASSWORD_ROUTING_URL_REFUSED');
      let url; try { url = new URL(entry.url); } catch { fail('PASSWORD_ROUTING_URL_REFUSED'); }
      if (url.protocol !== 'https:' || url.hostname !== entry.tenant + '.8415wallet.com' ||
          url.username || url.password || url.search || url.hash || /[\\\s%]/.test(entry.url) ||
          url.href !== entry.url || !url.pathname.endsWith('/web/index.html') ||
          url.pathname.includes('//') || !/^https:\/\/[^/]+:[1-9][0-9]{0,4}\//.test(entry.url)) fail('PASSWORD_ROUTING_URL_REFUSED');
      if (entry.url !== tenantUrls[entry.tenant]) fail('PASSWORD_ROUTING_ORIGIN_REFUSED');
    }
    return Object.freeze({ ...entry });
  });
  return Object.freeze(entries);
}
export function passwordTenantDestination(routes, tenant, action) {
  if (!Object.hasOwn(PASSWORD_PANELS, action)) fail('PASSWORD_ROUTING_ACTION_REFUSED');
  const entry = validatePasswordRoutes({ schema: '8415wallet-password-routing/1', entries: routes }).find(row => row.tenant === tenant);
  if (!entry) fail('PASSWORD_ROUTING_TENANT_REFUSED');
  if (!entry.url || !entry.passwordManagementReady) fail('PASSWORD_ROUTING_NOT_DEPLOYED');
  return entry.url + PASSWORD_PANELS[action];
}
export async function loadPasswordRoutes(fetcher = globalThis.fetch) {
  const options = { cache: 'no-store', credentials: 'omit', redirect: 'error' };
  // Separate operator-owned PUBLIC status, never an edit to the signed archive.
  // No credentials, tenant probes or redirects are sent to another origin.
  let response = await fetcher(new URL('/.well-known/8415wallet-password-routing.json', import.meta.url), options);
  if (response.status === 404) response = await fetcher(new URL('./tenant-password-routing.json', import.meta.url), options);
  if (!response.ok) fail('PASSWORD_ROUTING_UNAVAILABLE');
  const text = await response.text();
  if (text.length > 8192) fail('PASSWORD_ROUTING_SCHEMA_REFUSED');
  let value; try { value = JSON.parse(text); } catch { fail('PASSWORD_ROUTING_SCHEMA_REFUSED'); }
  return validatePasswordRoutes(value);
}
