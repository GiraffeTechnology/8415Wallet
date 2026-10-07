import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { findAcceptanceClaim } = createRequire(import.meta.url)('../scripts/package/release-contract.mjs');

// The check exists to stop a build asserting it has been accepted. The text it
// scans is the text that disclaims exactly that, so the two look alike and a
// literal match refuses the disclaimer it is meant to protect.
test('a disclaimer is not a claim, however it is phrased', () => {
  for (const text of [
    'Not independently audited.',
    'This build has not been independently audited.',
    'It is never independently audited.',
    'No independent review; it is not production-ready.',
    'Released without security approval.',
    'This is yet to be release-accepted.',
  ]) assert.equal(findAcceptanceClaim(text), null, text);
});

test('an asserted claim is still refused', () => {
  for (const text of [
    'This build is independently audited.',
    'The kernel is security-approved.',
    'This release is production ready.',
    'Status: release-accepted.',
    'The audit complete, ship it.',
  ]) assert.notEqual(findAcceptanceClaim(text), null, text);
});

// What the previous implementation did, kept as the reason this one exists.
test('the superseded form rejected its own disclaimer', () => {
  const superseded = (notice: string) => [/independently audited/i, /security[- ]approved/i,
    /production[- ]ready/i, /release[- ]accepted/i]
    .some(claim => claim.test(notice.replace(/not independently audited/gi, '')
      .replace(/NOT_INDEPENDENTLY_AUDITED/g, '')));

  const disclaimer = 'This build has not been independently audited.';
  assert.equal(superseded(disclaimer), true, 'the old form refused this disclaimer');
  assert.equal(findAcceptanceClaim(disclaimer), null, 'the current form keeps it');
});
