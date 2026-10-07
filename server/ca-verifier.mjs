/** Hardware CA verification boundary. Device middleware retains the private key. */
import { X509Certificate, verify, constants } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const run = promisify(execFile);
const refused = () => { throw new Error('CA_PROOF_REFUSED'); };
export async function createCaVerifier({ trustRootsPath, crlPath, opensslPath = 'openssl' }) {
  if (typeof trustRootsPath !== 'string' || typeof crlPath !== 'string') throw new Error('CA_TRUST_AND_REVOCATION_REQUIRED');
  const roots = resolve(trustRootsPath), crls = resolve(crlPath);
  await Promise.all([access(roots), access(crls)]);
  return async ({ message, signature, certificateChain, algorithm }) => {
    if (typeof message !== 'string' || message.length > 4096 || typeof signature !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length > 2048 ||
        typeof certificateChain !== 'string' || certificateChain.length > 65536) refused();
    const bytes = Buffer.from(signature, 'base64'); if (bytes.toString('base64') !== signature) refused();
    const pems = certificateChain.match(/-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g);
    if (!pems || pems.length > 6 || certificateChain.replace(/-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g, '').trim()) refused();
    let leaf;
    try { leaf = new X509Certificate(pems[0]); } catch { refused(); }
    const type = leaf.publicKey.asymmetricKeyType;
    if (leaf.ca || !leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.2')) refused();
    if (algorithm === 'RSA-PSS-SHA256') {
      if (!['rsa', 'rsa-pss'].includes(type) || leaf.publicKey.asymmetricKeyDetails.modulusLength < 2048) refused();
    } else if (algorithm === 'ECDSA-SHA256') {
      if (type !== 'ec' || !['prime256v1', 'secp384r1', 'secp521r1'].includes(leaf.publicKey.asymmetricKeyDetails.namedCurve)) refused();
    } else refused();
    const directory = await mkdtemp(join(tmpdir(), '8415-ca-'));
    try {
      const cert = join(directory, 'leaf.pem'), intermediates = join(directory, 'intermediates.pem');
      await writeFile(cert, pems[0], { mode: 0o600 });
      const args = ['verify', '-no-CApath', '-no-CAstore', '-CAfile', roots, '-CRLfile', crls,
        '-crl_check_all', '-x509_strict', '-auth_level', '2', '-purpose', 'sslclient', '-verify_depth', '5'];
      if (pems.length > 1) { await writeFile(intermediates, pems.slice(1).join('\n'), { mode: 0o600 }); args.push('-untrusted', intermediates); }
      args.push(cert);
      // No shell, AIA fetching, system trust fallback, caller-controlled paths or
      // soft-fail OCSP. OpenSSL checks time, constraints, purpose and current CRLs.
      try { await run(opensslPath, args, { timeout: 5000, maxBuffer: 16384, env: { PATH: process.env.PATH } }); }
      catch { refused(); }
      const key = algorithm === 'RSA-PSS-SHA256' ? { key: leaf.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : leaf.publicKey;
      if (!verify('sha256', Buffer.from(message, 'utf8'), key, bytes)) refused();
      return { fingerprint: leaf.fingerprint256.replaceAll(':', '').toLowerCase() };
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
}
