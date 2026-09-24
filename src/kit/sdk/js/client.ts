import type { Address, Bytes32, Instant, ProjectionEntry, Settlement, TokenId } from '../../engine/projection/types.ts';

export interface HttpLike {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: 'error';
  }): Promise<{
    status: number;
    json(): Promise<unknown>;
  }>;
}

export class ProjectionClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ProjectionClientError';
    this.status = status;
    this.code = code;
  }
}

/** Raised for an instant the projection does not cover. Distinct on purpose. */
export class NotCoveredError extends ProjectionClientError {
  constructor(message: string) {
    super(404, 'INSTANT_NOT_COVERED', message);
    this.name = 'NotCoveredError';
  }
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetch?: HttpLike;
  /** Per-request timeout. A read that never returns is a read that never fails. */
  readonly timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Refuses a base URL that would send an API key in clear, or one carrying
 * embedded credentials. Loopback stays allowed for development.
 *
 * Ported from the transport checks in the closed codex/stage5-sdk branch.
 */
const assertSafeBaseUrl = (baseUrl: string): void => {
  const url = new URL(baseUrl);
  if (url.username !== '' || url.password !== '') {
    throw new Error('the base URL must not carry embedded credentials');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('use https, or http only for a loopback development host');
  }
};

/**
 * Client for the Kit's projection API.
 *
 * The three questions stay three methods. There is deliberately no
 * `getStatus()` returning one value, because a caller handed a single status
 * cannot tell which question it was answered — the error the standard says an
 * asynchronous register makes easy.
 */
export class ProjectionClient {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: HttpLike;
  readonly #timeoutMs: number;

  constructor(options: ClientOptions) {
    this.#apiKey = options.apiKey;
    assertSafeBaseUrl(options.baseUrl);
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as HttpLike);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The holder the register had confirmed at an instant. Nothing more. */
  async holderAsOf(tokenId: TokenId, instant: Instant): Promise<Address> {
    const body = await this.#get<{ holder: Address }>(`/projection/${tokenId}/holder/as-of/${instant}`);
    return body.holder;
  }

  /** Whether a later admission can still change that answer. Never throws for an uncovered instant. */
  async isFinalAsOf(tokenId: TokenId, instant: Instant): Promise<boolean> {
    const body = await this.#get<{ final: boolean }>(`/projection/${tokenId}/finality/as-of/${instant}`);
    return body.final;
  }

  async entryAsOf(tokenId: TokenId, instant: Instant): Promise<ProjectionEntry> {
    const body = await this.#get<{ entry: WireEntry }>(`/projection/${tokenId}/entry/as-of/${instant}`);
    return decodeEntry(body.entry);
  }

  async entryAt(tokenId: TokenId, version: bigint): Promise<ProjectionEntry> {
    const body = await this.#get<{ entry: WireEntry }>(`/projection/${tokenId}/entry/version/${version}`);
    return decodeEntry(body.entry);
  }

  async entryCount(tokenId: TokenId): Promise<number> {
    const body = await this.#get<{ entryCount: number }>(`/projection/${tokenId}/entries`);
    return body.entryCount;
  }

  async entries(tokenId: TokenId): Promise<ProjectionEntry[]> {
    const entries: ProjectionEntry[] = [];
    let total: number | undefined;
    do {
      const offset = entries.length;
      const limit = total === undefined ? 100 : Math.min(100, total - offset);
      const body = await this.#get<{ entryCount: number; offset: number; entries: WireEntry[] }>(
        `/projection/${tokenId}/entries?offset=${offset}&limit=${limit}`,
      );
      if (!Number.isSafeInteger(body.entryCount) || body.entryCount < (total ?? 0) ||
          body.offset !== offset || !Array.isArray(body.entries)) {
        throw new ProjectionClientError(502, 'INVALID_PAGE', 'invalid history page metadata');
      }
      total ??= body.entryCount;
      if (body.entries.length !== Math.min(limit, total - offset)) {
        throw new ProjectionClientError(502, 'INVALID_PAGE', 'history page is incomplete');
      }
      entries.push(...body.entries.map(decodeEntry));
    } while (entries.length < total);
    return entries;
  }

  /** The open settlement, or null. A contract without settlement conformance has none. */
  async openGapOf(tokenId: TokenId): Promise<Settlement | null> {
    const body = await this.#get<{ openGap: WireSettlement | null }>(`/projection/${tokenId}`);
    return body.openGap === null ? null : decodeSettlement(body.openGap);
  }

  /**
   * All three facts from one server snapshot, each still labelled as itself.
   *
   * This is a convenience for a caller that needs all three; it is not a
   * status. `holder` is who was recorded, `final` is whether that can still
   * move, and `openGap` is whether a change is in flight. Acting on `holder`
   * without reading `final` is the integration error this shape makes hard to
   * commit by accident and impossible to commit silently.
   */
  async resolve(tokenId: TokenId, instant: Instant): Promise<{
    holder: Address;
    final: boolean;
    openGap: Settlement | null;
  }> {
    const body = await this.#get<{ holder: Address; final: boolean; openGap: WireSettlement | null }>(
      `/projection/${tokenId}/resolve/as-of/${instant}`,
    );
    return { holder: body.holder, final: body.final,
      openGap: body.openGap === null ? null : decodeSettlement(body.openGap) };
  }

  async #get<T>(path: string): Promise<T> {
    // Reads only, so a timeout is safe to surface: there is no write here that
    // a retry could duplicate, and this client never retries one.
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: 'error',
      ...(this.#apiKey === undefined ? {} : { headers: { authorization: `Bearer ${this.#apiKey}` } }),
    });
    const body = (await response.json()) as T & { error?: string; message?: string };
    if (response.status >= 400) {
      const code = body.error ?? 'UNKNOWN';
      const message = body.message ?? code;
      if (code === 'INSTANT_NOT_COVERED') throw new NotCoveredError(message);
      throw new ProjectionClientError(response.status, code, message);
    }
    return body;
  }
}

interface WireEntry {
  version: string;
  holder: string;
  effectiveAt: string;
  supersededAt: string;
  recordCommitment: string;
  previousCommitment: string;
  registryReference: string;
}

interface WireSettlement {
  settlementId: string;
  tokenId: string;
  initiator: string;
  expectedHolder: string;
  snapshotHash: string;
  openedAt: string;
  deadline: string;
  status: string;
}

/** Every uint64 arrives as a decimal string and becomes a bigint here, never a number. */
const decodeEntry = (wire: WireEntry): ProjectionEntry => ({
  version: BigInt(wire.version),
  holder: wire.holder,
  effectiveAt: BigInt(wire.effectiveAt),
  supersededAt: BigInt(wire.supersededAt),
  recordCommitment: wire.recordCommitment,
  previousCommitment: wire.previousCommitment,
  registryReference: wire.registryReference,
});

const decodeSettlement = (wire: WireSettlement): Settlement => ({
  settlementId: wire.settlementId as Bytes32,
  tokenId: BigInt(wire.tokenId),
  initiator: wire.initiator,
  expectedHolder: wire.expectedHolder,
  snapshotHash: wire.snapshotHash as Bytes32,
  openedAt: BigInt(wire.openedAt),
  deadline: BigInt(wire.deadline),
  status: wire.status as Settlement['status'],
});
