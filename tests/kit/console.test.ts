import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Directory, AccessDenied } from '../../src/kit/engine/access/roles.ts';
import { createConsole, handleConsole, type ConsoleOptions } from '../../src/kit/console/server.ts';
import { overview, timeline } from '../../src/kit/console/view.ts';
import { renderOverview } from '../../src/kit/console/render.ts';
import { SettlementEngine } from '../../src/kit/engine/settlement/engine.ts';
import { AllowListAuthority } from '../../src/kit/engine/settlement/authority.ts';
import { ALICE, BOB, CAROL, admit, commitment, entry, harness } from './support/fixtures.ts';

const TOKEN = 1n;
const ADMIN = 'admin@example.org';
const AUDITOR = 'auditor@example.org';
const VIEWER = 'viewer@example.org';

const scene = (withGap = false) => {
  const h = harness();
  admit(h, TOKEN, entry({ version: 1n, holder: ALICE, effectiveAt: 100n, recordCommitment: commitment(1) }));
  admit(h, TOKEN, entry({
    version: 2n, holder: BOB, effectiveAt: 130n,
    recordCommitment: commitment(2), previousCommitment: commitment(1),
  }));

  const clock = { now: () => 1_000n };
  const settlement = new SettlementEngine({
    store: h.store, authority: new AllowListAuthority([ALICE]), clock, settlementPeriod: 86_400n,
  });
  if (withGap) {
    settlement.begin({
      tokenId: TOKEN, settlementId: commitment(0x5e77), initiator: ALICE,
      expectedHolder: CAROL, snapshotHash: commitment(0x5a), deadline: 4_000n,
    });
  }

  const directory = new Directory([[ADMIN, 'ADMIN'], [AUDITOR, 'AUDITOR'], [VIEWER, 'VIEWER']]);
  const options: ConsoleOptions = {
    store: h.store, directory, settlement, clock,
    // The ERC-721 owner has moved on; the register has not caught up.
    ownerOf: () => CAROL,
  };
  return { h, options, directory, settlement };
};

test('the tradeable position and the confirmed holder are separate facts', () => {
  const s = scene();
  const view = overview({ store: s.h.store, tokenId: TOKEN, instant: 120n, owner: CAROL });

  assert.equal(view.tradeablePosition, CAROL);
  assert.equal(view.confirmedHolder, ALICE);
  // Neither is derived from the other, and they are allowed to disagree.
  assert.notEqual(view.tradeablePosition, view.confirmedHolder);
});

test('an uncovered instant shows no confirmed holder and says why', () => {
  const s = scene();
  const view = overview({ store: s.h.store, tokenId: TOKEN, instant: 99n, owner: CAROL });

  // Never filled in from the owner: an owner is not a register record.
  assert.equal(view.confirmedHolder, null);
  assert.equal(view.coverage, 'not-covered');
  assert.equal(view.tradeablePosition, CAROL);
  assert.equal(view.final, false);
});

test('a token with no projection is distinguished from an uncovered instant', () => {
  const s = scene();
  const view = overview({ store: s.h.store, tokenId: 99n, instant: 120n, owner: CAROL });
  assert.equal(view.coverage, 'no-projection');
  assert.equal(view.confirmedHolder, null);
  assert.equal(view.entryCount, 0);
});

test('the overview never merges the three signals', () => {
  const s = scene(true);
  const view = overview({
    store: s.h.store, settlement: s.settlement, tokenId: TOKEN, instant: 120n, owner: CAROL,
  });

  // Final, and a gap is open at the same time. One does not imply the other.
  assert.equal(view.final, true);
  assert.equal(view.openGap?.status, 'OPEN');

  const page = renderOverview(view);
  // None of these is ever a legitimate word here: they are the shorthand
  // lifecycle the standard does not define.
  for (const forbidden of ['Pending', 'Rejected', 'Released', 'Refunded', 'Locked']) {
    assert.ok(!page.includes(forbidden), `the page renders the word ${forbidden}`);
  }
  // "Confirmed" is protocol vocabulary in exactly one phrase, and is never a
  // status of its own.
  const confirmed = page.match(/Confirmed[^<]*/g) ?? [];
  assert.deepEqual(confirmed, ['Confirmed holder (register)']);

  assert.match(page, /this instant is final/);
  assert.match(page, /Change in flight/);
});

test('a provisional instant is labelled provisional, not failed', () => {
  const s = scene();
  const page = renderOverview(overview({ store: s.h.store, tokenId: TOKEN, instant: 140n, owner: CAROL }));
  assert.match(page, /this instant is provisional/);
  assert.ok(!/error|failed|invalid/i.test(page));
});

test('the timeline carries commitments and locators, never register contents', () => {
  const s = scene(true);
  const rows = timeline(s.h.store.entries(TOKEN), s.h.store.settlementsFor(TOKEN));

  // Ordered by the instant each takes effect: both entries take effect in the
  // register's own time, the gap opens later on the chain's clock.
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.kind), ['entry', 'entry', 'settlement']);
  assert.deepEqual(rows.map((r) => r.at), ['100', '130', '1000']);

  const labels = rows.flatMap((r) => r.detail.map(([label]) => label));
  assert.ok(labels.includes('recordCommitment'));
  assert.ok(labels.includes('registryReference'));
  for (const forbidden of ['record', 'document', 'deed', 'contents']) {
    assert.ok(!labels.includes(forbidden), `the timeline exposes ${forbidden}`);
  }
});

test('the timeline shows a closed entry as closed and the latest as open', () => {
  const s = scene();
  const rows = timeline(s.h.store.entries(TOKEN), []);
  const superseded = rows.map((r) => Object.fromEntries(r.detail)['supersededAt']);
  assert.deepEqual(superseded, ['130', 'open']);
});

test('roles gate what the console will show', () => {
  const s = scene();
  const ask = (user: string | undefined, path: string) =>
    handleConsole(s.options, { method: 'GET', path, ...(user === undefined ? {} : { user }) });

  assert.equal(ask(undefined, '/token/1').status, 401);
  assert.equal(ask('nobody@example.org', '/token/1').status, 403);

  assert.equal(ask(VIEWER, '/token/1').status, 200);
  assert.equal(ask(VIEWER, '/token/1/timeline').status, 403);
  assert.equal(ask(VIEWER, '/permissions').status, 403);

  assert.equal(ask(AUDITOR, '/token/1/timeline').status, 200);
  assert.equal(ask(AUDITOR, '/permissions').status, 403);

  assert.equal(ask(ADMIN, '/permissions').status, 200);
});

test('only an admin may change a role', () => {
  const s = scene();
  assert.throws(() => s.directory.assign(VIEWER, 'new@example.org', 'ADMIN'), AccessDenied);
  assert.throws(() => s.directory.assign(AUDITOR, 'new@example.org', 'VIEWER'), AccessDenied);
  assert.throws(() => s.directory.revoke(AUDITOR, VIEWER), AccessDenied);

  s.directory.assign(ADMIN, 'new@example.org', 'VIEWER');
  assert.equal(s.directory.roleOf('new@example.org'), 'VIEWER');
  s.directory.revoke(ADMIN, 'new@example.org');
  assert.equal(s.directory.roleOf('new@example.org'), undefined);
});

test('no role can write to a projection, because no route can', () => {
  const s = scene();
  for (const user of [ADMIN, AUDITOR, VIEWER]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/token/1', '/token/1/timeline', '/permissions', '/token/1/admission']) {
        const response = handleConsole(s.options, { method, path, user });
        // Reads are method-agnostic here; what matters is that nothing writes.
        assert.ok(response.status === 200 || response.status === 403 || response.status === 404);
      }
    }
  }
  assert.equal(s.h.store.entryCount(TOKEN), 2);
  assert.equal(s.h.store.holderAsOf(TOKEN, 120n), ALICE);

  // And no permission exists that could grant a write.
  assert.deepEqual(
    [...s.directory.permissionsOf(ADMIN)].sort(),
    ['audit:read', 'permissions:manage', 'projection:read'],
  );
});

test('a malformed token id or instant is refused', () => {
  const s = scene();
  assert.equal(handleConsole(s.options, { method: 'GET', path: '/token/abc', user: VIEWER }).status, 400);
  assert.equal(
    handleConsole(s.options, { method: 'GET', path: '/token/1', user: VIEWER, query: { instant: 'soon' } }).status,
    400,
  );
});

test('the console reads without Web3 vocabulary in the page copy', () => {
  const s = scene();
  const page = renderOverview(overview({ store: s.h.store, tokenId: TOKEN, instant: 120n, owner: CAROL }));
  // The labels a non-Web3 reader needs are spelled out.
  assert.match(page, /Tradeable position \(ERC-721 owner\)/);
  assert.match(page, /Confirmed holder \(register\)/);
  assert.match(page, /Can a later admission change the confirmed holder\?/);
});

test('page output escapes what it renders', () => {
  const s = scene();
  const view = { ...overview({ store: s.h.store, tokenId: TOKEN, instant: 120n }), registerId: '<script>x</script>' };
  const page = renderOverview(view);
  assert.ok(!page.includes('<script>'));
  assert.match(page, /&lt;script&gt;/);
});


test('the console transport requires a verified subject before role checks', async () => {
  const s = scene();
  const secret = randomBytes(32).toString('hex');
  const server = createConsole({ ...s.options, authenticate: async (request) =>
    request.headers.authorization === `Bearer ${secret}` ? VIEWER : undefined });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${url}/token/1`)).status, 401);
    const headers = { authorization: `Bearer ${secret}` };
    assert.equal((await fetch(`${url}/token/1`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/permissions`, { headers })).status, 403);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('console authentication failures return a closed response', async () => {
  const s = scene();
  const server = createConsole({ ...s.options, authenticate: () => { throw new Error('session service unavailable'); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/token/1`);
    assert.equal(response.status, 401);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
