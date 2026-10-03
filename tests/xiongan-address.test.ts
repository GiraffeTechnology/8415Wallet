import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { isAddressInput } from '../src/xiongan/address.ts';
import { keccak256Utf8 } from '../src/codec/keccak.ts';

// Official ERC-55 vectors: https://eips.ethereum.org/EIPS/eip-55#test-cases
const vectors = [
  '0x52908400098527886E0F7030069857D2E4169EE7',
  '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
  '0xde709f2102306220921060314715629080e2fb77',
  '0x27b1fdb04752bbc536007a920d24acb045561c26',
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
];
test('ERC-55 official vectors and unchecksummed lower/upper case remain supported', () => {
  for (const address of vectors) {
    assert.equal(getAddress(address), address);
    for (const input of [address, address.toLowerCase(), `0x${address.slice(2).toUpperCase()}`])
      assert.equal(isAddressInput(input), true, input);
  }
});
test('ERC-55 rejects single-letter case changes and preserves zero/format rejection', () => {
  for (const address of vectors) for (let i = 2; i < address.length; i++) {
    const character = address[i]!;
    if (!/[a-f]/i.test(character)) continue;
    const flipped = character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
    const changed = address.slice(0, i) + flipped + address.slice(i + 1);
    assert.equal(isAddressInput(changed), false, changed);
  }
  for (const value of [null, undefined, 1, {}, [], '', `0x${'0'.repeat(40)}`, '0x1234',
    vectors[4]!.slice(0, -1), vectors[4] + '0', `0X${vectors[4]!.slice(2)}`, ` ${vectors[4]}`,
    `${vectors[4]}\n`, `${vectors[4]!.toLowerCase()}\n`, `0xg${'1'.repeat(39)}`, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAec'])
    assert.equal(isAddressInput(value), false, String(value));
});
test('ERC-55 parser matches independent ethers address validation for deterministic mutations', () => {
  const accepted = (value: string) => { try { getAddress(value); return true; } catch { return false; } };
  for (let seed = 0; seed < 64; seed++) {
    const address = getAddress(keccak256Utf8(`checksum-regression-${seed}`).slice(0, 42));
    assert.equal(isAddressInput(address), true);
    for (let i = 2; i < address.length; i++) {
      const replacement = address[i] === '0' ? '1' : '0';
      const changed = address.slice(0, i) + replacement + address.slice(i + 1);
      assert.equal(isAddressInput(changed), accepted(changed), changed);
    }
  }
});
