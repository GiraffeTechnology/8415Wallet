/** Public binding validation. Never returns credential material. */
import { isAbsolute, normalize } from 'node:path';
import { getAddress } from 'ethers';
import { loginOrigin } from '../web/login-core.mjs';
const chains = new Set(['1', '8453', '11155111', '84532', '560048', '31337']);
const fail = code => { throw new Error(code); };
export function validateAccountBindings(accounts) {
  if (!Array.isArray(accounts) || !accounts.length || accounts.length > 10000) fail('AUTH_ACCOUNTS_REQUIRED');
  const names = new Set(), pairs = new Set();
  for (const user of accounts) {
    if (user && Object.keys(user).some(key => !['username', 'wallets', 'passwordHash', 'caFingerprints'].includes(key))) fail('AUTH_ACCOUNT_FIELD_REFUSED');
    if (!user || typeof user.username !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(user.username) ||
      ['__proto__', 'constructor', 'prototype'].includes(user.username) || names.has(user.username)) fail('AUTH_USERNAME_REFUSED');
    names.add(user.username);
    if (!Array.isArray(user.wallets) || !user.wallets.length || user.wallets.length > 64) fail('AUTH_WALLET_BINDING_REQUIRED');
    for (const wallet of user.wallets) {
      if (wallet && Object.keys(wallet).some(key => !['account', 'chainId'].includes(key))) fail('AUTH_WALLET_FIELD_REFUSED');
      if (!wallet || typeof wallet.account !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet.account) ||
        /^0x0{40}$/i.test(wallet.account) || typeof wallet.chainId !== 'string' || !chains.has(wallet.chainId)) fail('AUTH_WALLET_BINDING_REFUSED');
      // Match the service's identity canonicalization, including mixed case.
      const pair = `${getAddress(wallet.account.toLowerCase())}:${wallet.chainId}`;
      if (pairs.has(pair)) fail('AUTH_DUPLICATE_WALLET_CHAIN_BINDING');
      pairs.add(pair);
    }
    if (user.passwordHash !== undefined && !/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(user.passwordHash)) fail('AUTH_PASSWORD_HASH_REFUSED');
    if (user.caFingerprints !== undefined && (!Array.isArray(user.caFingerprints) ||
      !user.caFingerprints.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))) fail('AUTH_CA_BINDING_REFUSED');
  }
  return Object.freeze({ accountCount: names.size, bindingCount: pairs.size });
}
export function validateAuthConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('AUTH_CONFIG_REFUSED');
  if (Object.keys(config).some(key => !['origin', 'tenant', 'port', 'statePath', 'accounts', 'ca', 'reservedPorts', 'socketPath'].includes(key))) fail('AUTH_CONFIG_FIELD_REFUSED');
  const url = loginOrigin(config.origin);
  if (url.origin !== config.origin || typeof config.tenant !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(config.tenant)) fail('AUTH_ORIGIN_TENANT_REFUSED');
  if (config.socketPath !== undefined) {
    if (config.port !== undefined || typeof config.socketPath !== 'string' || !/^\/[A-Za-z0-9_./-]+\.sock$/.test(config.socketPath) || normalize(config.socketPath) !== config.socketPath || Buffer.byteLength(config.socketPath) > 100) fail('AUTH_SOCKET_PATH_REFUSED');
  } else if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) fail('AUTH_LOOPBACK_PORT_REFUSED');
  if (config.reservedPorts !== undefined && (!Array.isArray(config.reservedPorts) || config.reservedPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535) || config.reservedPorts.includes(config.port))) fail('AUTH_RESERVED_PORT_REFUSED');
  if (typeof config.statePath !== 'string' || !isAbsolute(config.statePath) || normalize(config.statePath) !== config.statePath ||
    config.statePath.includes('\0')) fail('AUTH_STATE_PATH_REFUSED');
  return validateAccountBindings(config.accounts);
}
