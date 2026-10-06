/**
 * One implementation of "does this text claim acceptance".
 *
 * It was written twice. build-v3 matched the phrases literally and then, to
 * avoid refusing its own disclaimer, deleted the words "not independently
 * audited" from the text before testing. That only recognised the one spelling
 * it had been told about: "has not been independently audited" and "never
 * independently audited" were both rejected as claims.
 */

export const REQUIRED_NOTICE = 'NOT_INDEPENDENTLY_AUDITED';

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
