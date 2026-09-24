import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { bindingDigest } from './binding.ts';
import { admitted, refused, type ProofContext, type ProofMaterial, type ProofProfile, type ProofVerdict } from './profile.ts';
import type { Instant } from '../projection/types.ts';

/** Domain separation. A signature made for anything else will not verify here. */
export const ATTESTATION_DOMAIN = 'erc8415-kit:attestation:v1';

/** An attestation may not be valid for longer than this. */
export const MAX_ATTESTATION_WINDOW: Instant = 86_400n;

export interface AttestationOptions {
  /** Issuer name to raw 32-byte Ed25519 public key, base64 or 0x-hex. */
  readonly trustedIssuers: Readonly<Record<string, string>>;
  readonly clock: { now(): Instant };
}

/**
 * Institutional attestation: a named issuer signs that a specific admission is
 * the register's record.
 *
 * This is a verification profile, so it decides admission validity and nothing
 * else. A verified attestation does not make any instant final — only a
 * strictly later admitted entry does — and it does not establish that the
 * registrar signed truthfully. It establishes that a trusted issuer signed
 * this exact admission, within a bounded window.
 *
 * The signed message is the admission binding digest under a domain string,
 * so an attestation cannot be lifted onto a different chain, contract, token,
 * settlement, holder, commitment pair, version or effective time.
 *
 * Ported from the Stage 2 work in the closed codex/stage2-verification branch,
 * rebound from that branch's mutable asset snapshot to this repository's
 * admission binding.
 */
export class Ed25519AttestationProfile implements ProofProfile {
  readonly id = 'attestation/ed25519/v1';
  readonly #issuers = new Map<string, KeyObject>();
  readonly #clock: { now(): Instant };

  constructor(options: AttestationOptions) {
    for (const [issuer, key] of Object.entries(options.trustedIssuers)) {
      this.#issuers.set(issuer, publicKeyFrom(key));
    }
    this.#clock = options.clock;
  }

  /** The exact bytes an issuer signs. */
  message(context: ProofContext, expiresAt: Instant, issuer: string): Buffer {
    return Buffer.from(
      [ATTESTATION_DOMAIN, issuer, expiresAt.toString(), bindingDigest(context.binding, context.candidate)]
        .map((field) => `${field.length}:${field}`)
        .join('|'),
      'utf8',
    );
  }

  verify(material: ProofMaterial, context: ProofContext): ProofVerdict {
    const issuer = material.payload['issuer'];
    const signature = material.payload['signature'];
    const expiresAtRaw = material.payload['expiresAt'];

    if (typeof issuer !== 'string' || typeof signature !== 'string' || typeof expiresAtRaw !== 'string') {
      return refused('attestation payload needs issuer, expiresAt and signature');
    }

    const key = this.#issuers.get(issuer);
    if (key === undefined) return refused(`untrusted attestation issuer: ${issuer}`);

    let expiresAt: Instant;
    try {
      expiresAt = BigInt(expiresAtRaw);
    } catch {
      return refused('expiresAt is not an integer');
    }

    // Bounded on both sides. An expired attestation is stale; one valid for
    // years is a standing permission nobody reviews.
    const now = this.#clock.now();
    if (expiresAt <= now) return refused('the attestation has expired');
    if (expiresAt - now > MAX_ATTESTATION_WINDOW) return refused('the attestation window is too long');

    let raw: Buffer;
    try {
      raw = decode(signature);
    } catch {
      return refused('signature is not valid base64 or hex');
    }
    if (raw.length !== 64) return refused('signature is not 64 bytes');

    if (!verify(null, this.message(context, expiresAt, issuer), key, raw)) {
      return refused('the attestation does not verify for this admission');
    }
    return admitted;
  }
}

const decode = (value: string): Buffer =>
  value.startsWith('0x') ? Buffer.from(value.slice(2), 'hex') : Buffer.from(value, 'base64');

/** Accepts a raw 32-byte key; wraps it in the Ed25519 SPKI prefix. */
const publicKeyFrom = (value: string): KeyObject => {
  const raw = decode(value);
  if (raw.length !== 32) throw new RangeError('an Ed25519 public key is 32 bytes');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
};
