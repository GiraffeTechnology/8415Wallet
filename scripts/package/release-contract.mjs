/**
 * One statement of what this release is, for every builder that has to say it.
 *
 * The status, the gates and the refusal to claim acceptance were written
 * independently in each builder and had already drifted: the page called itself
 * a development candidate while the artifacts called themselves a beta, and the
 * two builders solved the same false-positive problem in two different ways,
 * one of them by deleting the disclaimer's text before testing for it.
 *
 * Anything that states the release's status imports it from here.
 */

export const STATUS = 'BETA_FUNCTIONAL_TESTING_NOT_INDEPENDENTLY_AUDITED';
export const REQUIRED_NOTICE = 'NOT_INDEPENDENTLY_AUDITED';

/**
 * A beta's gates are not a release's gates. These three are what the build
 * exists to collect; carrying them as blockers would describe it as waiting for
 * its own purpose, and nothing would ever ship.
 */
export const BETA_COLLECTS = Object.freeze([
  'public-chain execution with a genuine wallet',
  'physical device journeys in a wallet application in-app browser',
  'W-20 deployed same-token multi-wallet journey',
]);

/** Review bounds what the build may be used for; it does not block publishing. */
export const BEFORE_GENERAL_RELEASE = Object.freeze([
  'independent security review of the control kernel, adapters, verifiers, deployed contracts, recovery and optional payment integration',
]);

/**
 * These phrases are claims only when asserted. The shipped text says "Not
 * independently audited", which is the opposite, so a negation immediately
 * before the phrase clears it. Matching the phrase alone would refuse the very
 * disclaimer this check exists to protect -- which is why one caller used to
 * delete the disclaimer from the text before testing, a workaround that only
 * recognised the two spellings it had been told about.
 */
const NEGATION = String.raw`(?:not|never|no|without|refuses? to be|yet to be|pending)\s+(?:\w+\s+){0,2}`;
const CLAIMS = ['independently audited', 'security[- ]approved', 'production[- ]ready',
  'release[- ]accepted', 'audit(?:ed)? complete'];
export const FORBIDDEN_CLAIMS = Object.freeze(
  CLAIMS.map((claim) => new RegExp(String.raw`(?<!${NEGATION})(?:${claim})`, 'i')));

/** Returns the matched claim, or null when the text asserts none. */
export function findAcceptanceClaim(text) {
  for (const claim of FORBIDDEN_CLAIMS) if (claim.test(text)) return claim;
  return null;
}
