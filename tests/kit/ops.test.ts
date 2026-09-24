import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiKeyStore } from '../../src/kit/engine/ops/apiKeys.ts';
import { TenantRegistry, UnknownTenant } from '../../src/kit/engine/ops/tenants.ts';
import { Metrics } from '../../src/kit/engine/ops/metrics.ts';
import { exportAudit, toNdjson } from '../../src/kit/engine/ops/auditExport.ts';
import { handleGateway } from '../../src/kit/api/gateway.ts';
import { SettlementEngine } from '../../src/kit/engine/settlement/engine.ts';
import { AllowListAuthority } from '../../src/kit/engine/settlement/authority.ts';
import { ALICE, BOB, CAROL, admit, commitment, entry, harness } from './support/fixtures.ts';

const TOKEN = 1n;
const clock = { now: () => 1_000n };

const tenant = (holder: string, tokenId = TOKEN) => {
  const h = harness();
  admit(h, tokenId, entry({ version: 1n, holder, effectiveAt: 100n, recordCommitment: commitment(1) }));
  return h;
};

test('an api key is stored only as a hash and verified in constant time', () => {
  const keys = new ApiKeyStore(clock);
  const issued = keys.issue('acme', 'ci');

  assert.equal(keys.authenticate(issued.secret)?.tenantId, 'acme');
  assert.equal(keys.authenticate(`${issued.secret}x`), undefined);
  assert.equal(keys.authenticate('nonsense'), undefined);
  assert.equal(keys.authenticate(''), undefined);

  // Nothing on the store hands back a secret or a hash.
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(keys));
  for (const forbidden of ['secret', 'secretOf', 'hash', 'hashOf', 'export']) {
    assert.ok(!surface.includes(forbidden), `the key store exposes ${forbidden}`);
  }
  const listed = keys.list('acme');
  assert.deepEqual(Object.keys(listed[0] ?? {}).sort(), ['createdAt', 'keyId', 'label', 'revokedAt', 'tenantId']);
  const serialised = JSON.stringify(listed, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  assert.ok(!serialised.includes(issued.secret));
});

test('a revoked key stops authenticating', () => {
  const keys = new ApiKeyStore(clock);
  const issued = keys.issue('acme', 'ci');
  assert.ok(keys.authenticate(issued.secret) !== undefined);

  keys.revoke(issued.record.keyId);
  assert.equal(keys.authenticate(issued.secret), undefined);
  // Revoking twice is harmless and does not resurrect the key.
  keys.revoke(issued.record.keyId);
  assert.equal(keys.authenticate(issued.secret), undefined);
});

test('a tenant cannot read another tenant projection', () => {
  const keys = new ApiKeyStore(clock);
  const metrics = new Metrics();
  const tenants = new TenantRegistry();
  tenants.add('acme', tenant(ALICE).store);
  tenants.add('globex', tenant(BOB).store);

  const acme = keys.issue('acme', 'ci').secret;
  const globex = keys.issue('globex', 'ci').secret;
  const ask = (apiKey: string) =>
    handleGateway({ tenants, keys, metrics }, { method: 'GET', path: '/projection/1/holder/as-of/120', apiKey });

  assert.equal((ask(acme).body as { holder: string }).holder, ALICE);
  assert.equal((ask(globex).body as { holder: string }).holder, BOB);

  // The tenant comes from the key, so there is no request field to forge.
  assert.equal(tenants.storeFor('acme').holderAsOf(TOKEN, 120n), ALICE);
  assert.throws(() => tenants.storeFor('initech'), UnknownTenant);
});

test('an unauthenticated or rejected request reads nothing', () => {
  const keys = new ApiKeyStore(clock);
  const metrics = new Metrics();
  const tenants = new TenantRegistry();
  tenants.add('acme', tenant(ALICE).store);
  const gateway = { tenants, keys, metrics };

  assert.equal(handleGateway(gateway, { method: 'GET', path: '/projection/1/holder/as-of/120' }).status, 401);
  assert.equal(
    handleGateway(gateway, { method: 'GET', path: '/projection/1/holder/as-of/120', apiKey: 'k8415_x_y' }).status,
    401,
  );

  const revoked = keys.issue('acme', 'old');
  keys.revoke(revoked.record.keyId);
  assert.equal(
    handleGateway(gateway, { method: 'GET', path: '/projection/1/holder/as-of/120', apiKey: revoked.secret }).status,
    401,
  );
});

test('refusals are metered, not only successes', () => {
  const keys = new ApiKeyStore(clock);
  const metrics = new Metrics();
  const tenants = new TenantRegistry();
  tenants.add('acme', tenant(ALICE).store);
  const gateway = { tenants, keys, metrics };
  const apiKey = keys.issue('acme', 'ci').secret;

  handleGateway(gateway, { method: 'GET', path: '/projection/1/holder/as-of/120', apiKey });
  handleGateway(gateway, { method: 'GET', path: '/projection/1/holder/as-of/99', apiKey });
  handleGateway(gateway, { method: 'GET', path: '/projection/1/holder/as-of/120' });
  handleGateway(gateway, { method: 'GET', path: '/projection/1/holder/as-of/120', apiKey: 'k8415_bad_bad' });

  const outcomes = metrics.samples().map((sample) => sample.labels['outcome']);
  assert.ok(outcomes.includes('ok'));
  assert.ok(outcomes.includes('refused'));
  assert.ok(outcomes.includes('unauthenticated'));
  assert.ok(outcomes.includes('rejected'));
});

test('metrics never carry projection data', () => {
  const metrics = new Metrics();
  for (const label of Metrics.FORBIDDEN_LABELS) {
    assert.throws(() => metrics.increment('x', { [label]: 'value' }), /metrics surface/);
  }

  const keys = new ApiKeyStore(clock);
  const tenants = new TenantRegistry();
  tenants.add('acme', tenant(ALICE).store);
  const apiKey = keys.issue('acme', 'ci').secret;
  handleGateway({ tenants, keys, metrics }, { method: 'GET', path: '/projection/1/holder/as-of/120', apiKey });

  // The route label keeps its shape and loses its identifiers.
  const rendered = metrics.render();
  assert.match(rendered, /route="projection\/:id\/holder\/as-of\/:id"/);
  assert.ok(!rendered.includes(ALICE));
  assert.ok(!rendered.includes('120'));
});

test('the audit export carries the trail and not the register', () => {
  const h = tenant(ALICE);
  const settlement = new SettlementEngine({
    store: h.store, authority: new AllowListAuthority([ALICE]), clock, settlementPeriod: 86_400n,
  });
  settlement.begin({
    tokenId: TOKEN, settlementId: commitment(0x5e77), initiator: ALICE,
    expectedHolder: CAROL, snapshotHash: commitment(0x5a), deadline: 4_000n,
  });

  const records = exportAudit('acme', h.store);
  assert.deepEqual(records.map((record) => record.type), ['entry', 'settlement']);
  assert.equal(records[0]?.tenantId, 'acme');
  assert.equal(records[0]?.detail['holder'], ALICE);
  assert.equal(records[0]?.detail['recordCommitment'], commitment(1));

  // A commitment and a locator, never the record behind them.
  const fields = records.flatMap((record) => Object.keys(record.detail));
  for (const forbidden of ['record', 'document', 'contents', 'deed', 'payload']) {
    assert.ok(!fields.includes(forbidden), `the export carries ${forbidden}`);
  }
});

test('the export is streamable and keeps uint64 as strings', () => {
  const h = tenant(ALICE);
  admit(h, TOKEN, entry({
    version: 2n, holder: BOB, effectiveAt: 2n ** 53n + 1n,
    recordCommitment: commitment(2), previousCommitment: commitment(1),
  }));

  const lines = toNdjson(exportAudit('acme', h.store)).split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line) as { at: string; detail: Record<string, string> };
    assert.equal(typeof parsed.at, 'string');
    assert.equal(typeof parsed.detail['effectiveAt'], 'string');
  }
  // The large instant survives the round trip exactly.
  const last = JSON.parse(lines[1] as string) as { detail: Record<string, string> };
  assert.equal(BigInt(last.detail['effectiveAt'] as string), 2n ** 53n + 1n);
});

test('an export covers one tenant and stops there', () => {
  const acme = tenant(ALICE);
  const globex = tenant(BOB, 7n);

  const acmeRecords = exportAudit('acme', acme.store);
  const globexRecords = exportAudit('globex', globex.store);

  assert.deepEqual(acmeRecords.map((r) => r.tokenId), ['1']);
  assert.deepEqual(globexRecords.map((r) => r.tokenId), ['7']);
  assert.ok(acmeRecords.every((r) => r.tenantId === 'acme'));
  assert.ok(!JSON.stringify(acmeRecords).includes(BOB));
});
