import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const at = (...parts: string[]) => join(root, ...parts);

/**
 * Layout acceptance for the merged repository.
 *
 * This began as the Kit's Stage 0 acceptance test, asserting that repository's
 * own directory plan. The Kit is no longer a separate repository: its engine,
 * API, adapters and contracts are vendored here under `src/kit` and
 * `contracts`, so the layout this asserts is the merged one. The two checks
 * worth keeping unchanged are at the bottom — the frozen interface identifiers
 * and the removed legacy documents — because neither is about where files sit.
 */
test('the merged layout exists', () => {
  for (const path of [
    'src/wallet',
    'src/sdk',
    'src/codec',
    'src/adapters',
    'src/cli',
    'src/kit/engine',
    'src/kit/api',
    'src/kit/adapters',
    'src/kit/sdk',
    'src/kit/console',
    'contracts',
    'conformance',
    'docker',
    'tests',
  ]) {
    assert.ok(existsSync(at(path)), `missing directory: ${path}`);
  }
});

test('the Kit specification came across with the code', () => {
  for (const doc of [
    'docs/kit/ERC8415-Native-Infrastructure-Kit-PRD-v2.1.md',
    'docs/kit/ERC-8415-Native-Infrastructure-Kit-PRD-Stage-Delivery-v2.0.md',
    'docs/kit/ERC8415-SEMANTIC-MODEL.md',
    'docs/kit/GAP-SEMANTICS.md',
  ]) {
    assert.ok(existsSync(at(doc)), `missing document: ${doc}`);
  }
});

test("the wallet's own specification is still the reading order it names", () => {
  for (const doc of [
    'AGENTS.md',
    'README.md',
    'docs/ERC-8415-Wallet-PRD.md',
    'docs/INTEGRATION.md',
    'docs/STAGE-DELIVERY.md',
  ]) {
    assert.ok(existsSync(at(doc)), `missing document: ${doc}`);
  }
});

test('the development environment is defined and containerised', () => {
  assert.ok(existsSync(at('docs/kit/DEVELOPMENT.md')));
  assert.ok(existsSync(at('docker/Dockerfile')));
  assert.ok(existsSync(at('docker/compose.yaml')));
  assert.ok(existsSync(at('.github/workflows/ci.yml')));
});

// The removed v1.0-era documents specified a different product — a mutable
// institutional asset registry with freeze and revoke authority. Nothing
// should reintroduce them, or the vocabulary they used for projection state.
test('no legacy task document has returned', () => {
  for (const gone of [
    'CODEX_TASK.md',
    'CODEX-WORK-INIT.md',
    'CODEX-ITERATION-TASK-v2.1.md',
    'CODEX-SEMANTIC-HARDENING-TASK-v2.md',
    'CODEX-AUTONOMOUS-DEVELOPMENT-TASK.md',
    'HANDOFF.md',
    'docs/kit/ERC8415-Native-Infrastructure-Kit-PRD-Stage-Delivery-v1.0.md',
  ]) {
    assert.ok(!existsSync(at(gone)), `legacy document is back: ${gone}`);
  }
});

test('the frozen interface identifiers are recorded unchanged', () => {
  const agents = readFileSync(at('AGENTS.md'), 'utf8');
  assert.match(agents, /`0x6309e170`[^.]*`IRegisterProjection`/);
  assert.match(agents, /`0xf4a7d71b`[^.]*`IProjectionSettlement`/);
});
