import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign, X509Certificate, constants } from 'node:crypto';
import { createCaVerifier } from '../server/ca-verifier.mjs';
// All CA material below is generated per test in a private temporary directory.
// It is never used for a real identity or checked into a delivery artifact.
test('hardware CA verifies real signature, trusted chain, EKU and mandatory current revocation evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), '8415-ca-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  await writeFile(join(directory, 'index'), ''); await writeFile(join(directory, 'serial'), '1000\n'); await writeFile(join(directory, 'crlnumber'), '1000\n');
  await writeFile(join(directory, 'ca.conf'), `[ca]\ndefault_ca = local\n[local]\ndir = ${directory}\ndatabase = $dir/index\nserial = $dir/serial\ncrlnumber = $dir/crlnumber\nnew_certs_dir = $dir\ncertificate = $dir/root.pem\nprivate_key = $dir/root.key\ndefault_md = sha256\ndefault_days = 2\ndefault_crl_days = 1\npolicy = names\nx509_extensions = client\n[names]\ncommonName = supplied\n[client]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = clientAuth\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid,issuer\n[server]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = serverAuth\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid,issuer\n`);
  run('req', '-new', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-noenc', '-keyout', 'root.key', '-out', 'root.pem', '-days', '2', '-subj', '/CN=Synthetic test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'subjectKeyIdentifier=hash');
  const issue = (name: string, extra: string[] = []) => {
    run('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-noenc', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
    run('ca', '-batch', '-notext', '-config', 'ca.conf', '-in', `${name}.csr`, '-out', `${name}.pem`, ...extra);
  };
  issue('client');
  run('req', '-new', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'rsa.key', '-out', 'rsa.csr', '-subj', '/CN=rsa');
  run('ca', '-batch', '-notext', '-config', 'ca.conf', '-in', 'rsa.csr', '-out', 'rsa.pem');
  issue('expired', ['-startdate', '20000101000000Z', '-enddate', '20010101000000Z']); issue('server', ['-extensions', 'server']);
  run('ca', '-gencrl', '-config', 'ca.conf', '-out', 'root.crl');
  const verify = await createCaVerifier({ trustRootsPath: join(directory, 'root.pem'), crlPath: join(directory, 'root.crl') });
  const message = '8415wallet synthetic origin-bound challenge; no standing authority';
  const proof = async (name: string) => ({ message, signature: sign('sha256', Buffer.from(message), await readFile(join(directory, `${name}.key`))).toString('base64'),
    certificateChain: await readFile(join(directory, `${name}.pem`), 'utf8'), algorithm: 'ECDSA-SHA256' });
  const rsaKey = await readFile(join(directory, 'rsa.key'));
  const rsaProof = { message, signature: sign('sha256', Buffer.from(message), { key: rsaKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64'),
    certificateChain: await readFile(join(directory, 'rsa.pem'), 'utf8'), algorithm: 'RSA-PSS-SHA256' };
  assert.match((await verify(rsaProof)).fingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(verify({ ...rsaProof, signature: sign('sha256', Buffer.from(message), rsaKey).toString('base64') }), /REFUSED/);
  const valid = await proof('client');
  assert.equal((await verify(valid)).fingerprint, new X509Certificate(valid.certificateChain).fingerprint256.replaceAll(':', '').toLowerCase());
  await assert.rejects(verify({ ...valid, message: `${message} substituted` }), /REFUSED/);
  await assert.rejects(verify({ ...valid, signature: `${valid.signature}\n` }), /REFUSED/);
  await assert.rejects(verify({ ...valid, algorithm: 'RSA-PSS-SHA256' }), /REFUSED/);
  await assert.rejects(verify({ ...valid, certificateChain: `${valid.certificateChain}\nnot a certificate` }), /REFUSED/);
  await assert.rejects(verify(await proof('expired')), /REFUSED/);
  await assert.rejects(verify(await proof('server')), /REFUSED/);
  run('ca', '-config', 'ca.conf', '-revoke', 'client.pem'); run('ca', '-gencrl', '-config', 'ca.conf', '-out', 'root.crl');
  await assert.rejects(verify(valid), /REFUSED/);
  await writeFile(join(directory, 'root.crl'), ''); await assert.rejects(verify(valid), /REFUSED/);
  await assert.rejects(createCaVerifier({ trustRootsPath: join(directory, 'root.pem') }), /REVOCATION/);
});
