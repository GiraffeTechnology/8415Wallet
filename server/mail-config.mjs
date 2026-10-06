/** Fixed-product, non-secret installed mail configuration and inert operator review. */
import { isIP } from 'node:net';
export const MAIL_HOST = 'mail.8415wallet.com';
export const MAIL_FROM = 'noreply@8415wallet.com';
const fail = () => { throw Error('AUTH_MAIL_CONFIG_REFUSED'); };
export function validateMailConfig(value = { transport: 'disabled' }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const keys = Object.keys(value).sort().join(',');
  if (value.transport === 'disabled' && keys === 'transport') return Object.freeze({ transport: 'disabled' });
  if (value.transport !== 'smtp' || keys !== 'addresses,port,transport' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || value.port === 443 ||
      !Array.isArray(value.addresses) || !value.addresses.length || value.addresses.length > 8) fail();
  const addresses = value.addresses.map(address => {
    if (typeof address !== 'string' || address !== address.trim() || !isIP(address) || address.includes('%') || address.includes('/') ||
        address === '0.0.0.0' || address === '255.255.255.255' || address === '::' || address === '::1' ||
        /^(?:0|127|22[4-9]|23\d|24\d|25[0-5])\./.test(address) || /^169\.254\./.test(address) || /^(?:ff|fe[89ab]|::ffff:)/i.test(address)) fail();
    const canonical = isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
    if (canonical === '::' || canonical === '::1' || /^::ffff:/i.test(canonical)) fail();
    return canonical;
  });
  if (new Set(addresses).size !== addresses.length) fail();
  return Object.freeze({ transport: 'smtp', port: value.port, addresses: Object.freeze(addresses) });
}

export function pinnedMailLookup(addresses) {
  const pins = validateMailConfig({ transport: 'smtp', port: 465, addresses }).addresses;
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const family = typeof options === 'number' ? options : options?.family ?? 0;
    const matches = pins.map(address => ({ address, family: isIP(address) })).filter(item => family === 0 || item.family === family);
    queueMicrotask(() => {
      if (hostname !== MAIL_HOST || ![0, 4, 6].includes(family) || !matches.length) return callback(Error('AUTH_EMAIL_UNAVAILABLE'));
      if (options?.all) callback(null, matches);
      else callback(null, matches[0].address, matches[0].family);
    });
  };
}

export function smtpReviewOverride(tenant, value) {
  if (typeof tenant !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(tenant)) fail();
  const mail = validateMailConfig(value), name = `8415wallet-auth-${tenant}`;
  const prefix = '# INERT REVIEW ONLY. Operator approval is required before installing this drop-in.\n# Never place credentials in this file. The base unit and all other hardening stay intact.\n';
  const common = `[Service]\nLoadCredential=\nLoadCredential=store-key:/etc/${name}/store-key\nRestrictAddressFamilies=\nIPAddressAllow=\nIPAddressDeny=any\n`;
  if (mail.transport === 'disabled') return prefix + common + 'RestrictAddressFamilies=AF_UNIX\nIPAddressAllow=localhost\n';
  return prefix + `# Fixed host ${MAIL_HOST}; sender ${MAIL_FROM}; implicit TLS port ${mail.port}.\n# Application TLS verifies this hostname; pinned lookup has no DNS fallback.\n` + common +
    `LoadCredential=smtp-username:/etc/${name}/smtp-username\nLoadCredential=smtp-password:/etc/${name}/smtp-password\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n` +
    mail.addresses.map(address => `IPAddressAllow=${address}/${isIP(address) === 4 ? 32 : 128}\n`).join('');
}

/** The caller supplies its existing protected-file reader, never an arbitrary credential path. */
export async function installedMailEnvironment(value, credentialDirectory, readProtectedFile) {
  const mail = validateMailConfig(value);
  if (mail.transport === 'disabled') return {};
  if (!/^\/run\/credentials\/8415wallet-auth-[a-z][a-z0-9-]{0,47}\.service$/.test(credentialDirectory)) fail();
  const buffers = [];
  try {
    for (const [name, limit] of [['smtp-username', 256], ['smtp-password', 1024]]) {
      const buffer = await readProtectedFile(`${credentialDirectory}/${name}`, limit); buffers.push(buffer);
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > limit || !Buffer.from(buffer.toString('utf8')).equals(buffer)) throw Error();
    }
    const username = buffers[0].toString('utf8'), password = buffers[1].toString('utf8');
    if (/[\x00-\x1f\x7f]/.test(username) || /[\x00\r\n]/.test(password)) throw Error();
    return { WALLET_AUTH_SMTP_PORT: String(mail.port), WALLET_AUTH_SMTP_USERNAME: username, WALLET_AUTH_SMTP_PASSWORD: password };
  } catch { throw Error('AUTH_MAIL_CREDENTIAL_REQUIRED'); }
  finally { for (const buffer of buffers) if (Buffer.isBuffer(buffer)) buffer.fill(0); }
}
