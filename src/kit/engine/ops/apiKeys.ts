import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface ApiKeyRecord {
  readonly keyId: string;
  readonly tenantId: string;
  readonly label: string;
  readonly createdAt: bigint;
  readonly revokedAt: bigint | null;
}

export interface IssuedKey {
  readonly record: ApiKeyRecord;
  /** Shown once. Nothing stores it, so it cannot be recovered or leaked later. */
  readonly secret: string;
}

const digest = (secret: string): Buffer => createHash('sha256').update(secret).digest();

/**
 * API keys for tenant authentication.
 *
 * Only a hash of each secret is kept, so a dump of this store does not let
 * anyone authenticate. Comparison is constant time, so a caller cannot learn a
 * secret by measuring how quickly a wrong one is refused.
 */
export class ApiKeyStore {
  readonly #records = new Map<string, ApiKeyRecord>();
  readonly #hashes = new Map<string, Buffer>();
  readonly #clock: { now(): bigint };

  constructor(clock: { now(): bigint }) {
    this.#clock = clock;
  }

  issue(tenantId: string, label: string): IssuedKey {
    const keyId = randomBytes(8).toString('hex');
    const secret = `k8415_${keyId}_${randomBytes(24).toString('hex')}`;
    const record: ApiKeyRecord = {
      keyId, tenantId, label, createdAt: this.#clock.now(), revokedAt: null,
    };
    this.#records.set(keyId, record);
    this.#hashes.set(keyId, digest(secret));
    return { record, secret };
  }

  /** The tenant a secret authenticates, or undefined. Never throws on bad input. */
  authenticate(secret: string): ApiKeyRecord | undefined {
    const keyId = secret.split('_')[1];
    if (keyId === undefined) return undefined;

    const record = this.#records.get(keyId);
    const expected = this.#hashes.get(keyId);
    if (record === undefined || expected === undefined) return undefined;

    const supplied = digest(secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
    if (record.revokedAt !== null) return undefined;
    return record;
  }

  revoke(keyId: string): ApiKeyRecord | undefined {
    const record = this.#records.get(keyId);
    if (record === undefined || record.revokedAt !== null) return record;
    const revoked: ApiKeyRecord = { ...record, revokedAt: this.#clock.now() };
    this.#records.set(keyId, revoked);
    return revoked;
  }

  /** Records only. There is no accessor that returns a secret or a hash. */
  list(tenantId: string): readonly ApiKeyRecord[] {
    return [...this.#records.values()].filter((record) => record.tenantId === tenantId);
  }
}
