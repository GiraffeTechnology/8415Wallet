/** Release identity is presentation configuration, never signing authority. */
const freeze = value => {
  Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); });
  return Object.freeze(value);
};
export const RELEASE_PROFILES = freeze({
  v2: { id: 'v2', label: '8415wallet V2 Beta', version: '2.2.0-beta',
    prd: { version: '2.2', sections: ['1', '2', '3', '4', '5', '6', '7', '8'], scenarios: [] },
    features: { standalone: true, externalAssets: true, assetStandards: ['native-ETH', 'ERC-20', 'ERC-721', 'ERC-1155'], controlledAccounts: true, linkedResponsibilities: false } },
  v3: { id: 'v3', label: '8415wallet V3 Beta', version: '3.0.0-beta',
    prd: { version: '3.0', sections: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
      scenarios: Array.from({ length: 24 }, (_, i) => `W-${String(i + 1).padStart(2, '0')}`) },
    features: { standalone: true, externalAssets: true, assetStandards: ['native-ETH', 'ERC-20', 'ERC-721', 'ERC-1155'], controlledAccounts: true, linkedResponsibilities: true } },
});
export const RELEASE_STATUS = 'BETA_FUNCTIONAL_TESTING_NOT_INDEPENDENTLY_AUDITED';
const fail = code => { throw new Error(code); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');

export function validateDeploymentConfig(value) {
  const hasReservations = value && typeof value === 'object' && Object.hasOwn(value, 'reservedPorts');
  if (!exact(value, hasReservations ? 'environment,url,reservedPorts' : 'environment,url') || !['unconfigured', 'local', 'ctyun', 'sin', 'other'].includes(value.environment)) fail('RELEASE_DEPLOYMENT_SCHEMA_REFUSED');
  if (hasReservations && (!Array.isArray(value.reservedPorts) || value.reservedPorts.length > 256 ||
      value.reservedPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535) ||
      new Set(value.reservedPorts).size !== value.reservedPorts.length)) fail('RELEASE_RESERVED_PORTS_REFUSED');
  if (value.url === null) {
    if (value.environment !== 'unconfigured') fail('RELEASE_DEPLOYMENT_URL_REQUIRED');
    if (hasReservations) fail('RELEASE_DEPLOYMENT_SCHEMA_REFUSED');
    return freeze({ environment: 'unconfigured', url: null });
  }
  if (typeof value.url !== 'string' || value.url.length > 2048 || value.environment === 'unconfigured') fail('RELEASE_DEPLOYMENT_URL_REFUSED');
  let url;
  try { url = new URL(value.url); } catch { fail('RELEASE_DEPLOYMENT_URL_REFUSED'); }
  if (url.username || url.password || url.search || url.hash || /[\s\\]/.test(value.url)) fail('RELEASE_DEPLOYMENT_URL_REFUSED');
  // Validate any supplied port without requiring URL syntax to spell out the
  // protocol default. Reservations apply to the effective endpoint port.
  const authority = value.url.match(/^https?:\/\/(?:\[[0-9a-fA-F:]+\]|[^\/:?#]+)(?::([0-9]+))?\//);
  if (!authority || (authority[1] !== undefined && (!/^[1-9][0-9]{0,4}$/.test(authority[1]) || Number(authority[1]) > 65535))) fail('RELEASE_DEPLOYMENT_PORT_REFUSED');
  const port = Number(authority[1] ?? (url.protocol === 'https:' ? 443 : 80));
  if (hasReservations && value.reservedPorts.includes(port)) fail('RELEASE_RESERVED_PORT');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (value.environment === 'local' ? !local || !['http:', 'https:'].includes(url.protocol) : local || url.protocol !== 'https:') fail('RELEASE_SECURE_URL_REQUIRED');
  if (!url.pathname.endsWith('/web/index.html')) fail('RELEASE_ENTRY_URL_REQUIRED');
  const rawPath = value.url.match(/^https?:\/\/[^/]+(\/[^?#]*)$/)?.[1];
  if (!rawPath || rawPath !== url.pathname || rawPath.includes('%') || rawPath.includes('//')) fail('RELEASE_CANONICAL_PATH_REQUIRED');
  // Keep the configured URL exactly; no endpoint or replacement port is invented.
  return freeze({ environment: value.environment, url: value.url, ...(hasReservations ? { reservedPorts: [...value.reservedPorts] } : {}) });
}

export function resolveReleaseProfile(value) {
  if (!exact(value, 'schema,product,platform,profile,tenant,deployment') || value.schema !== '8415wallet-release/1' ||
      value.product !== '8415wallet' || value.platform !== '8415wallet.com' || !Object.hasOwn(RELEASE_PROFILES, value.profile)) fail('RELEASE_PROFILE_REFUSED');
  if (!exact(value.tenant, 'id,label') || !/^[a-z][a-z0-9-]{0,47}$/.test(value.tenant.id) ||
      typeof value.tenant.label !== 'string' || !/^[\x20-\x7e]{1,80}$/.test(value.tenant.label)) fail('RELEASE_TENANT_REFUSED');
  if (value.tenant.id === 'xiongan' && value.profile !== 'v2') fail('RELEASE_XIONGAN_V2_REQUIRED');
  return freeze({ ...RELEASE_PROFILES[value.profile], product: value.product, platform: value.platform,
    status: RELEASE_STATUS, tenant: { ...value.tenant }, deployment: validateDeploymentConfig(value.deployment) });
}

export function verifyReleaseLocation(profile, location = globalThis.location) {
  if (profile.deployment.url === null) return profile;
  let actual, expected;
  try { actual = new URL(location.href); expected = new URL(profile.deployment.url); }
  catch { fail('RELEASE_LOCATION_REQUIRED'); }
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search || actual.hash) fail('RELEASE_LOCATION_MISMATCH');
  return profile;
}

export async function loadReleaseProfile(fetcher = globalThis.fetch, location = globalThis.location) {
  if (typeof fetcher !== 'function') fail('RELEASE_CONFIG_UNAVAILABLE');
  const response = await fetcher(new URL('./release-config.json', import.meta.url), { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) fail('RELEASE_CONFIG_UNAVAILABLE');
  const text = await response.text();
  if (text.length > 8192) fail('RELEASE_CONFIG_TOO_LARGE');
  let value;
  try { value = JSON.parse(text); } catch { fail('RELEASE_CONFIG_INVALID'); }
  return verifyReleaseLocation(resolveReleaseProfile(value), location);
}

// One result or refusal per page lifetime: independent UI surfaces must not
// observe different configurations during a release switch or transient error.
let releaseProfilePromise;
export function getReleaseProfile() {
  releaseProfilePromise ??= loadReleaseProfile();
  return releaseProfilePromise;
}
