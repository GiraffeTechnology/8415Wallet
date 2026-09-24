import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import { MemoryRegisterContract } from '../src/adapters/memory/register.ts';
import {
  ALICE,
  CAROL,
  DAVE,
  STRANGER,
  T,
  TOKEN,
  divergentToken,
} from '../src/adapters/memory/scenarios.ts';
import { parseArgs, validate } from '../src/cli/args.ts';
import { discoverHeldTokens } from '../src/wallet/discovery.ts';
import { delegateReader } from './support/delegateReader.ts';

describe('finding which tokens an account holds', () => {
  test('discovers a token from the transfer log and confirms it against ownerOf', async () => {
    const { reader } = divergentToken();
    // The scenario minted to Alice and transferred the position to Dave.
    const found = await discoverHeldTokens(reader, DAVE);

    assert.equal(found.available, true);
    assert.deepEqual(
      found.held.map((token) => token.tokenId),
      [TOKEN],
    );
    assert.equal(found.held[0]?.hasProjection, true);
  });

  test('a previous holder is reported as moved on, not as held', async () => {
    const { reader } = divergentToken();
    const found = await discoverHeldTokens(reader, ALICE);

    assert.deepEqual(found.held, []);
    assert.deepEqual(found.movedOn, [TOKEN]);
  });

  test('an account that never received anything finds nothing', async () => {
    const found = await discoverHeldTokens(divergentToken().reader, STRANGER);
    assert.deepEqual(found.held, []);
    assert.deepEqual(found.movedOn, []);
  });

  test('confirms against ownerOf rather than trusting the log', async () => {
    const { contract, reader } = divergentToken();
    // Dave received it, then passed it on. The log still shows the receipt.
    contract.transfer(TOKEN, STRANGER);

    const dave = await discoverHeldTokens(reader, DAVE);
    assert.deepEqual(dave.held, []);
    assert.deepEqual(dave.movedOn, [TOKEN]);

    const stranger = await discoverHeldTokens(reader, STRANGER);
    assert.deepEqual(
      stranger.held.map((token) => token.tokenId),
      [TOKEN],
    );
  });

  test('reports a token with no projection entries as such', async () => {
    const contract = new MemoryRegisterContract({ now: T.v1 });
    contract.mint(7n, CAROL);
    const found = await discoverHeldTokens(new MemoryErc8415Reader(contract), CAROL);

    assert.equal(found.held[0]?.tokenId, 7n);
    assert.equal(found.held[0]?.hasProjection, false);
  });

  test('says it cannot discover rather than returning an empty list', async () => {
    const { reader } = divergentToken();
    const { getLogs: _omitted, ...withoutLogs } = delegateReader(reader, {});
    const found = await discoverHeldTokens(withoutLogs, DAVE);

    assert.equal(found.available, false);
    assert.deepEqual(found.held, []);
    assert.match(found.note, /not a statement that the account holds nothing/);
  });

  test('states that log retention can hide a token', async () => {
    const found = await discoverHeldTokens(divergentToken().reader, DAVE);
    assert.match(found.note, /trimmed by retention would hide a token/);
    assert.match(found.note, /not proof the account holds none/);
  });
});

describe('command line', () => {
  test('parses a live invocation', () => {
    const options = parseArgs([
      '--rpc',
      'https://node.example/v1',
      '--contract',
      `0x${'ab'.repeat(20)}`,
      '--token',
      '1234',
      '--instant',
      '1767225600',
      '--chain-id',
      '11155111',
    ]);

    assert.equal(options.rpc, 'https://node.example/v1');
    assert.equal(options.contract, `0x${'ab'.repeat(20)}`);
    assert.equal(options.token, 1234n);
    assert.equal(options.instant, 1_767_225_600n);
    assert.equal(options.chainId, 11_155_111n);
  });

  test('keeps a token id and an instant as bigint, never a number', () => {
    const options = parseArgs(['--token', '18446744073709551615', '--instant', '9223372036854775809']);
    // A uint64 past Number.MAX_SAFE_INTEGER must survive the command line too.
    assert.equal(options.token, 18_446_744_073_709_551_615n);
    assert.equal(options.instant, 9_223_372_036_854_775_809n);
  });

  test('rejects a malformed address, token or asset id', () => {
    assert.throws(() => parseArgs(['--contract', '0xnothex']), /not an address/);
    assert.throws(() => parseArgs(['--token', '12.5']), /not a whole number/);
    assert.throws(() => parseArgs(['--asset-id', '0xabcd']), /not a 32-byte value/);
  });

  test('rejects a flag with no value', () => {
    assert.throws(() => parseArgs(['--rpc', '--contract']), /--rpc needs a value/);
  });

  test('requires a contract alongside an endpoint', () => {
    assert.throws(
      () => validate(parseArgs(['--rpc', 'https://node.example'])),
      /there is no default deployment/,
    );
  });

  test('requires something to look at', () => {
    assert.throws(
      () =>
        validate(parseArgs(['--rpc', 'https://node.example', '--contract', `0x${'ab'.repeat(20)}`])),
      /supply --token, or --account/,
    );
  });

  test('requires a watchtower and an asset id together', () => {
    assert.throws(
      () =>
        validate(
          parseArgs([
            '--rpc',
            'https://node.example',
            '--contract',
            `0x${'ab'.repeat(20)}`,
            '--token',
            '1',
            '--watchtower',
            `0x${'cd'.repeat(20)}`,
          ]),
        ),
      /go together/,
    );
  });

  test('refuses an index without a node behind it', () => {
    // The Kit serves the projection. The tradeable position, the chain clock
    // and ERC-165 conformance are not in it, and answering `ownerOf` from the
    // register would state exactly the equivalence ERC-8415 denies.
    assert.throws(
      () => validate(parseArgs(['--kit', 'https://kit.example'])),
      /--kit needs --rpc/,
    );
  });

  test('validates nothing when no endpoint is given, so the demo still runs', () => {
    validate(parseArgs([]));
    assert.equal(parseArgs([]).rpc, undefined);
  });
});

describe('a failure to ask is not an answer', () => {
  test('a transport failure is not reported as non-conformance', async () => {
    const { reader } = divergentToken();
    const unreachable = delegateReader(reader, {
      supportsInterface: async () => {
        throw new Error('fetch failed');
      },
    });

    // Swallowing this would tell a user their contract is not an ERC-8415
    // contract because their node was down — a cause never established.
    const { detectConformance } = await import('../src/sdk/conformance.ts');
    await assert.rejects(() => detectConformance(unreachable), /fetch failed/);
  });

  test('a revert still reports honestly that the interface is not advertised', async () => {
    const { MemoryRegisterContract: Contract } = await import(
      '../src/adapters/memory/register.ts'
    );
    const contract = new Contract({ now: T.beforeFirstEntry, conformance: { erc165: false } });
    contract.mint(TOKEN, ALICE);

    const { detectConformance } = await import('../src/sdk/conformance.ts');
    assert.deepEqual(await detectConformance(new MemoryErc8415Reader(contract)), {
      erc165: false,
      projection: false,
      settlement: false,
    });
  });

  test('the live client says the endpoint was unreachable', async () => {
    const { explainFailure } = await import('../src/cli/live.ts');
    assert.match(explainFailure(new Error('fetch failed')), /Could not reach the JSON-RPC endpoint/);
  });
});
