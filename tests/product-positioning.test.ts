import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const prose = (value: string) => value.replace(/\s+/g, ' ');

for (const path of ['README.md', 'AGENTS.md', 'docs/ERC-8415-Wallet-PRD.md']) {
  test(`${path}: general-wallet identity, standards compatibility and versioned DApp scope agree`, () => {
    const text = prose(read(path));
    assert.match(text, /8415wallet/);
    assert.match(text, /general-purpose (?:application-layer )?wallet/);
    assert.match(text, /existing wallet and asset standards/);
    assert.match(text, /native ERC-8415|native \[ERC-8415/);
    assert.match(text, /8415wallet\.com/);
    assert.match(text, /Xiongan[^.]*V2 tenant/);
    assert.match(text, /DApp Beta|DApp[^.]*Beta/);
    assert.match(text, /STANDARDS-COMPATIBILITY\.md/);
    assert.doesNotMatch(text, /It is not a generic NFT wallet|a generic NFT wallet;/);
  });
}

test('compatibility matrix separates implemented operations from universal validation', () => {
  const text = prose(read('docs/STANDARDS-COMPATIBILITY.md'));
  for (const standard of ['ERC-20', 'ERC-721', 'ERC-1155', 'ERC-165', 'ERC-55', 'EIP-1193', 'EIP-712', 'ERC-1271', 'ERC-8415']) {
    assert.ok(text.includes(standard), standard);
  }
  assert.match(text, /does not claim exhaustive validation/);
  assert.match(text, /integer base units/);
  assert.match(text, /upgradeable proxy implementation/);
});

test('native PRD requirements hold, and port reservations stay out of them', () => {
  const prd = read('docs/ERC-8415-Wallet-PRD.md');
  for (const marker of ['# 1.', '# 2.', '# 3.', '# 4.', '# 5.', '# 6.', '# 7.', '# 8.', '# 9.']) assert.ok(prd.includes(marker), marker);
  for (let n = 1; n <= 24; n++) assert.ok(prd.includes(`| W-${String(n).padStart(2, '0')} |`));
  for (const identifier of ['0x6309e170', '0xf4a7d71b', 'beginSettlement', 'finalizeSettlement', 'cancelSettlement', '128']) assert.ok(prd.includes(identifier), identifier);
  // Which ports an environment reserves is deployment configuration, not a
  // product requirement, so the product instructions must not carry it and the
  // deployment document must.
  const instructions = prose(read('AGENTS.md'));
  assert.doesNotMatch(instructions, /\b443\b/);
  assert.doesNotMatch(instructions, /reserved for SSH|port reservation/);

  // What the product does own is that the serving address is part of stored
  // state, which holds whatever port an environment happens to use.
  assert.match(instructions, /A web origin is scheme, host \*\*and port\*\*/);
  assert.match(instructions, /strands them all/);

  const deployment = read('docs/deployment/SIN-STATIC-DEPLOYMENT-REQUIREMENTS.md');
  assert.match(deployment, /TCP 443 is reserved for SSH/);
});
