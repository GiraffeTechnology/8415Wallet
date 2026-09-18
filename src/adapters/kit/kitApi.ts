import { ContractRevertError, ValueOutOfRangeError } from '../../sdk/errors.ts';
import type { Address, Bytes32, Instant, RegisterEntry, TokenId, Version } from '../../sdk/types.ts';

/**
 * A client for the Native Infrastructure Kit's projection API.
 *
 * The Kit indexes a register's projection and serves it over HTTP. That is a
 * read path, not a second source of truth: every value it returns originated
 * in the same register the contract projects, and this client's job is to
 * carry those values across without reinterpreting them.
 *
 * Two distinctions are preserved here because the layers above are written
 * against them and would otherwise be silently wrong:
 *
 *  - A refusal that means *the projection has no answer* is raised as
 *    `ContractRevertError`, the same way the chain adapter surfaces a revert.
 *    `entryAsOf` before the first entry is specified behaviour, not a failure.
 *  - A refusal that means *the backend could not answer* — unauthenticated,
 *    unreachable, a malformed body, a server fault — is raised as
 *    `KitTransportError`. Collapsing the two lets an unreachable backend be
 *    reported as a statement about the register, which is the one thing a
 *    record-keeping wallet must never do.
 */

/** The Kit's HTTP surface, narrowed to what this client uses. */
export type KitFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: 'error';
  },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** The backend could not answer. Never a statement about the projection. */
export class KitTransportError extends Error {
  readonly status: number | undefined;
  readonly code: string;

  constructor(code: string, message: string, status?: number) {
    super(`kit backend: ${message}`);
    this.name = 'KitTransportError';
    this.code = code;
    this.status = status;
  }
}

export type KitApiOptions = {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetch?: KitFetch;
  /** A read that never returns is a read that never fails. */
  readonly timeoutMs?: number;
};

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Codes the Kit returns for "the projection does not answer that".
 *
 * These are the API's spelling of the contract's reverts. Everything outside
 * this set is a backend condition.
 */
const REVERT_CODES = new Set([
  'INSTANT_NOT_COVERED',
  'EMPTY_PROJECTION',
  'UNKNOWN_VERSION',
  'UNKNOWN_TOKEN',
]);

/** The projection facts one `GET /projection/{tokenId}` carries. */
export type KitProjectionSummary = {
  readonly registerId: Bytes32;
  readonly verificationProfile: Bytes32;
  readonly entryCount: bigint;
  /** `settlementId` of the open gap, or undefined when none is open. */
  readonly openGap: KitSettlement | undefined;
};

export type KitSettlement = {
  readonly settlementId: Bytes32;
  readonly tokenId: TokenId;
  readonly initiator: Address;
  readonly expectedHolder: Address;
  readonly snapshotHash: Bytes32;
  readonly openedAt: Instant;
  readonly deadline: Instant;
  readonly status: string;
};

export class KitProjectionApi {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: KitFetch;
  readonly #timeoutMs: number;

  constructor(options: KitApiOptions) {
    assertSafeBaseUrl(options.baseUrl);
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    const injected = options.fetch ?? (globalThis.fetch as unknown as KitFetch | undefined);
    if (injected === undefined) {
      throw new KitTransportError('NO_FETCH', 'no fetch implementation is available');
    }
    this.#fetch = injected;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async summary(tokenId: TokenId): Promise<KitProjectionSummary> {
    const body = await this.#get(`/projection/${tokenId}`);
    return {
      registerId: bytes32(body['registerId'], 'registerId'),
      verificationProfile: bytes32(body['verificationProfile'], 'verificationProfile'),
      entryCount: count(body['entryCount']),
      openGap: body['openGap'] == null ? undefined : toSettlement(body['openGap']),
    };
  }

  async entryAt(tokenId: TokenId, version: Version): Promise<RegisterEntry> {
    const body = await this.#get(`/projection/${tokenId}/entry/version/${version}`);
    return toEntry(body['entry']);
  }

  async entryAsOf(tokenId: TokenId, instant: Instant): Promise<RegisterEntry> {
    const body = await this.#get(`/projection/${tokenId}/entry/as-of/${instant}`);
    return toEntry(body['entry']);
  }

  async holderAsOf(tokenId: TokenId, instant: Instant): Promise<Address> {
    const body = await this.#get(`/projection/${tokenId}/holder/as-of/${instant}`);
    return address(body['holder'], 'holder');
  }

  /** Never reverts for an uncovered instant, matching `isFinalAsOf` on chain. */
  async isFinalAsOf(tokenId: TokenId, instant: Instant): Promise<boolean> {
    const body = await this.#get(`/projection/${tokenId}/finality/as-of/${instant}`);
    const final = body['final'];
    if (typeof final !== 'boolean') {
      throw new KitTransportError('MALFORMED_BODY', 'finality is not a boolean');
    }
    return final;
  }

  async #get(path: string): Promise<Record<string, unknown>> {
    let response: { status: number; json(): Promise<unknown> };
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(this.#apiKey === undefined
          ? {}
          : { headers: { authorization: `Bearer ${this.#apiKey}` } }),
      });
    } catch (error) {
      throw new KitTransportError('UNREACHABLE', `${path} did not complete: ${String(error)}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new KitTransportError(
        'MALFORMED_BODY',
        `${path} returned a body that is not JSON: ${String(error)}`,
        response.status,
      );
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new KitTransportError('MALFORMED_BODY', `${path} returned a non-object body`, response.status);
    }

    const body = payload as Record<string, unknown>;
    if (response.status >= 400) {
      const code = typeof body['error'] === 'string' ? body['error'] : 'UNKNOWN';
      const message = typeof body['message'] === 'string' ? body['message'] : code;
      if (REVERT_CODES.has(code)) {
        // The projection's own answer, carried across as the chain would give
        // it. The wallet layer establishes the cause from protocol data; it
        // never reads it out of this text.
        throw new ContractRevertError(`${path} (${code})`, undefined);
      }
      throw new KitTransportError(code, `${path} refused: ${message}`, response.status);
    }
    return body;
  }
}

/**
 * Refuse a base URL that would carry an API key in clear, or one with embedded
 * credentials. Loopback over http stays allowed for development.
 */
function assertSafeBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new KitTransportError('BAD_BASE_URL', `${baseUrl} is not a URL`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new KitTransportError('BAD_BASE_URL', 'the base URL must not carry embedded credentials');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new KitTransportError('BAD_BASE_URL', 'use https, or http only for a loopback host');
  }
}

const UINT64_MAX = (1n << 64n) - 1n;

/**
 * Every integer crosses the wire as a decimal string, and is read as a bigint.
 *
 * `Number` is never involved. An `effectiveAt` far enough in the future to end
 * a projection is exactly the value worth reporting accurately, and it does
 * not survive a double.
 */
function uint64(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new KitTransportError('MALFORMED_BODY', `${what} is not a decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) throw new ValueOutOfRangeError(what, parsed);
  return parsed;
}

function uint256(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new KitTransportError('MALFORMED_BODY', `${what} is not a decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << 256n) throw new ValueOutOfRangeError(what, parsed);
  return parsed;
}

/** `entryCount` crosses as a JSON number, and must be a whole count. */
function count(value: unknown): bigint {
  if (typeof value === 'string') return uint64(value, 'entryCount');
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new KitTransportError('MALFORMED_BODY', 'entryCount is not a whole count');
  }
  return BigInt(value);
}

function bytes32(value: unknown, what: string): Bytes32 {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new KitTransportError('MALFORMED_BODY', `${what} is not a 32-byte value`);
  }
  return value.toLowerCase();
}

function address(value: unknown, what: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new KitTransportError('MALFORMED_BODY', `${what} is not an address`);
  }
  return value.toLowerCase();
}

function toEntry(value: unknown): RegisterEntry {
  if (typeof value !== 'object' || value === null) {
    throw new KitTransportError('MALFORMED_BODY', 'entry is not an object');
  }
  const wire = value as Record<string, unknown>;
  return {
    recordCommitment: bytes32(wire['recordCommitment'], 'recordCommitment'),
    previousCommitment: bytes32(wire['previousCommitment'], 'previousCommitment'),
    registryReference: bytes32(wire['registryReference'], 'registryReference'),
    holder: address(wire['holder'], 'holder'),
    version: uint64(wire['version'], 'version'),
    effectiveAt: uint64(wire['effectiveAt'], 'effectiveAt'),
    supersededAt: uint64(wire['supersededAt'], 'supersededAt'),
  };
}

function toSettlement(value: unknown): KitSettlement {
  if (typeof value !== 'object' || value === null) {
    throw new KitTransportError('MALFORMED_BODY', 'settlement is not an object');
  }
  const wire = value as Record<string, unknown>;
  if (typeof wire['status'] !== 'string') {
    throw new KitTransportError('MALFORMED_BODY', 'settlement status is not a string');
  }
  return {
    settlementId: bytes32(wire['settlementId'], 'settlementId'),
    tokenId: uint256(wire['tokenId'], 'settlement tokenId'),
    initiator: address(wire['initiator'], 'initiator'),
    expectedHolder: address(wire['expectedHolder'], 'expectedHolder'),
    snapshotHash: bytes32(wire['snapshotHash'], 'snapshotHash'),
    openedAt: uint64(wire['openedAt'], 'openedAt'),
    deadline: uint64(wire['deadline'], 'deadline'),
    status: wire['status'],
  };
}
