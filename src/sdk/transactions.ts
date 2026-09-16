import { encodeCallWithTail, type AbiType, type AbiValue } from '../codec/abi.ts';
import { detectConformance, requireSettlementConformance } from './conformance.ts';
import type { Erc8415Reader } from './port.ts';
import { ZERO_BYTES32, type Address, type Bytes32, type Instant, type TokenId } from './types.ts';

/**
 * The wallet's only write path into the projection.
 *
 * Three operations, and no others: `beginSettlement`, `finalizeSettlement`,
 * `cancelSettlement`. There is no rollback, no veto, no override, and no way
 * to write an entry directly — the projection moves only through
 * proof-verified admission, and this module cannot make it do anything else.
 *
 * The wallet never holds key material. It builds an unsigned request and hands
 * it to a `TransactionSigner` the caller supplies: an injected provider, a
 * hardware wallet, a custodian's signing service. Nothing here reads, stores or
 * transmits a private key, because nothing here is ever given one.
 */

export type TransactionKind = 'beginSettlement' | 'finalizeSettlement' | 'cancelSettlement';

export type PreflightOutcome =
  /** Checked against the contract and satisfied. */
  | 'passed'
  /** Checked and violated: this transaction would revert. */
  | 'failed'
  /** Cannot be checked from here. Says so rather than implying it passed. */
  | 'unverifiable';

export type PreflightCheck = {
  readonly name: string;
  readonly outcome: PreflightOutcome;
  readonly detail: string;
};

export type PreflightReport = {
  readonly checks: readonly PreflightCheck[];
  /** Checks that failed. A request is never built while this is non-empty. */
  readonly blocking: readonly PreflightCheck[];
  /** What the wallet could not establish, stated so the caller can weigh it. */
  readonly unverifiable: readonly PreflightCheck[];
  /**
   * Effects of sending this that are not failures.
   *
   * Superseding an open gap, or cancelling and settling nothing, are the
   * transaction working as specified. A user should still be told before
   * signing.
   */
  readonly consequences: readonly string[];
};

export type TransactionRequest = {
  readonly kind: TransactionKind;
  readonly to: Address;
  readonly from: Address;
  readonly data: string;
  /** All three operations are non-payable. */
  readonly value: '0x0';
  readonly chainId: bigint;
  /** What sending this does, in protocol terms. */
  readonly summary: string;
  readonly preflight: PreflightReport;
};

/**
 * Where a signature comes from.
 *
 * Implemented outside the wallet. The wallet builds; the signer signs and
 * sends. Keeping them apart is what makes "no key material leaves the device"
 * true by construction rather than by policy.
 */
export type TransactionSigner = {
  readonly account: Address;
  sendTransaction(request: TransactionRequest): Promise<string>;
};

/** The wallet refuses to build a transaction it has established would revert. */
export class TransactionWouldRevertError extends Error {
  readonly kind: TransactionKind;
  readonly checks: readonly PreflightCheck[];

  constructor(kind: TransactionKind, checks: readonly PreflightCheck[]) {
    super(
      `refusing to build ${kind}: ${checks.map((check) => `${check.name} — ${check.detail}`).join('; ')}`,
    );
    this.name = 'TransactionWouldRevertError';
    this.kind = kind;
    this.checks = checks;
  }
}

const NOTE_SNAPSHOT =
  'Preflight reads a snapshot. State can change between building this and its ' +
  'inclusion in a block, and the contract re-checks everything on chain.';

export type BeginSettlementParams = {
  readonly tokenId: TokenId;
  readonly settlementId: Bytes32;
  readonly expectedHolder: Address;
  readonly snapshotHash: Bytes32;
  readonly deadline: Instant;
};

/**
 * Open a gap.
 *
 * An `expectedHolder` equal to the current confirmed holder is permitted and
 * useful: it admits a confirming entry, which is how instants become final on
 * a token whose holder is not changing.
 */
export async function buildBeginSettlement(
  reader: Erc8415Reader,
  from: Address,
  params: BeginSettlementParams,
): Promise<TransactionRequest> {
  const checks: PreflightCheck[] = [];
  const consequences: string[] = [];
  await requireSettlement(reader, 'beginSettlement', checks);

  if (params.settlementId === ZERO_BYTES32) {
    fail(checks, 'settlementId nonzero', 'a settlement identifier must be nonzero');
  } else if (reader.settlement !== undefined) {
    // `settlement` reverts for an unknown identifier, so resolving means used.
    let used = false;
    try {
      await reader.settlement(params.settlementId);
      used = true;
    } catch {
      used = false;
    }
    record(
      checks,
      'settlementId unused',
      used ? 'failed' : 'passed',
      used ? 'this identifier already names a settlement' : 'no settlement uses this identifier',
    );
  }

  if (params.snapshotHash === ZERO_BYTES32) {
    fail(checks, 'snapshot nonzero', 'a settlement snapshot must be nonzero');
  } else {
    pass(checks, 'snapshot nonzero', 'pins this settlement to one starting state');
  }

  try {
    await reader.ownerOf(params.tokenId);
    pass(checks, 'token exists', `token ${params.tokenId} is present`);
  } catch {
    fail(checks, 'token exists', `token ${params.tokenId} does not exist`);
  }

  if (reader.isSettlementAuthority !== undefined) {
    let authorized = false;
    try {
      authorized = await reader.isSettlementAuthority(params.tokenId, from);
    } catch {
      authorized = false;
    }
    record(
      checks,
      'settlement authority',
      authorized ? 'passed' : 'failed',
      authorized
        ? `${from} may open a gap on this token`
        : `${from} may not open a gap on this token; owning it does not confer the authority`,
    );
  }

  const now = await reader.chainInstant();
  if (params.deadline <= now) {
    fail(checks, 'deadline in the future', `deadline ${params.deadline} is not after ${now}`);
  } else if (reader.settlementPeriod !== undefined) {
    const period = await reader.settlementPeriod();
    const span = params.deadline - now;
    record(
      checks,
      'deadline within the settlement period',
      span <= period ? 'passed' : 'failed',
      `${span}s requested against a ${period}s maximum`,
    );
  }

  if (reader.openGapOf !== undefined) {
    const open = await reader.openGapOf(params.tokenId);
    if (open !== ZERO_BYTES32) {
      consequences.push(
        `A gap (${open}) is already open on this token. Beginning another supersedes ` +
          'it, leaves the projection unchanged, and makes any proof already produced ' +
          'for it unusable.',
      );
    }
  }

  return build(reader, 'beginSettlement', from, checks, consequences, {
    signature: 'beginSettlement(uint256,bytes32,address,bytes32,uint64)',
    types: ['uint256', 'bytes32', 'address', 'bytes32', 'uint64'],
    args: [
      params.tokenId,
      params.settlementId,
      params.expectedHolder,
      params.snapshotHash,
      params.deadline,
    ],
    summary:
      `Open a settlement gap on token ${params.tokenId}, asserting holder ` +
      `${params.expectedHolder} with a deadline at ${params.deadline}. This does not ` +
      'move the projection; only a verified proof does.',
  });
}

export type FinalizeSettlementParams = {
  readonly settlementId: Bytes32;
  readonly recordCommitment: Bytes32;
  readonly registryReference: Bytes32;
  readonly effectiveAt: Instant;
  readonly proofData: string;
};

/**
 * Admit an entry into an open gap.
 *
 * Permissionless: anyone may relay a proof, and submitting one grants no
 * rights. The wallet checks the invariants it can read and states plainly that
 * proof validity is not among them.
 */
export async function buildFinalizeSettlement(
  reader: Erc8415Reader,
  from: Address,
  params: FinalizeSettlementParams,
): Promise<TransactionRequest> {
  const checks: PreflightCheck[] = [];
  const consequences: string[] = [];
  await requireSettlement(reader, 'finalizeSettlement', checks);

  let tokenId: TokenId | undefined;
  if (reader.settlement !== undefined) {
    try {
      const record_ = await reader.settlement(params.settlementId);
      tokenId = record_.tokenId;
      record(
        checks,
        'settlement is open',
        record_.status === 'OPEN' ? 'passed' : 'failed',
        record_.status === 'OPEN'
          ? 'the gap is open and can accept an admission'
          : `the settlement is ${record_.status}; no entry can be admitted into it`,
      );
    } catch {
      fail(checks, 'settlement exists', `no settlement named ${params.settlementId}`);
    }
  }

  if (params.recordCommitment === ZERO_BYTES32) {
    fail(checks, 'record commitment nonzero', 'a record commitment must be nonzero');
  } else {
    pass(checks, 'record commitment nonzero', 'commits to the register content at this entry');
  }

  if (tokenId !== undefined) {
    const count = await reader.entryCount(tokenId);
    if (count > 0n) {
      const latest = await reader.currentEntry(tokenId);
      record(
        checks,
        'effectiveAt strictly increases',
        params.effectiveAt > latest.effectiveAt ? 'passed' : 'failed',
        `${params.effectiveAt} against the latest entry's ${latest.effectiveAt}; equal or ` +
          'earlier times are forbidden, because an instant shared by two entries would ' +
          'have two answers',
      );

      let repeated = false;
      for (let version = 1n; version <= count; version += 1n) {
        if ((await reader.entryAt(tokenId, version)).recordCommitment === params.recordCommitment) {
          repeated = true;
          break;
        }
      }
      record(
        checks,
        'record commitment unique within the token',
        repeated ? 'failed' : 'passed',
        repeated
          ? 'this commitment already appears in the token; two entries that cannot be ' +
            'told apart cannot be resolved'
          : 'no entry on this token carries this commitment',
      );
    }
  }

  record(
    checks,
    'proof validity',
    'unverifiable',
    'The wallet cannot verify the proof. The contract verifies it on chain under its ' +
      'verification profile, which you must accept before relying on this projection. ' +
      'A proof establishes inclusion in accepted finalized remote state — not that an ' +
      'asset exists, that a registrar told the truth, or that a record is legally effective.',
  );

  consequences.push(
    'Submitting a proof grants no rights over this token and confers no standing. ' +
      'If it verifies, the entry is appended, the prior interval closes and the gap ' +
      'closes, all in one transaction.',
  );

  return build(reader, 'finalizeSettlement', from, checks, consequences, {
    signature: 'finalizeSettlement(bytes32,bytes32,bytes32,uint64,bytes)',
    types: ['bytes32', 'bytes32', 'bytes32', 'uint64', 'bytes'],
    args: [
      params.settlementId,
      params.recordCommitment,
      params.registryReference,
      params.effectiveAt,
      params.proofData,
    ],
    summary:
      `Admit an entry effective at ${params.effectiveAt} into settlement ` +
      `${params.settlementId}, if its proof verifies on chain.`,
  });
}

export type CancelSettlementParams = {
  readonly settlementId: Bytes32;
  readonly reasonHash: Bytes32;
};

/**
 * Cancel an open gap, after its deadline.
 *
 * Ends the contest and settles nothing. The preceding entry stays in force and
 * no instant becomes final — a change the register has already made can still
 * be admitted afterwards. That is stated as a consequence so nobody signs this
 * believing it resolves anything.
 */
export async function buildCancelSettlement(
  reader: Erc8415Reader,
  from: Address,
  params: CancelSettlementParams,
): Promise<TransactionRequest> {
  const checks: PreflightCheck[] = [];
  const consequences: string[] = [];
  await requireSettlement(reader, 'cancelSettlement', checks);

  const now = await reader.chainInstant();
  if (reader.settlement !== undefined) {
    try {
      const record_ = await reader.settlement(params.settlementId);
      record(
        checks,
        'settlement is open',
        record_.status === 'OPEN' ? 'passed' : 'failed',
        record_.status === 'OPEN' ? 'the gap is open' : `the settlement is already ${record_.status}`,
      );
      record(
        checks,
        'caller is the recorded initiator',
        from === record_.initiator ? 'passed' : 'failed',
        from === record_.initiator
          ? `${from} opened this settlement`
          : `${record_.initiator} opened this settlement, not ${from}`,
      );
      record(
        checks,
        'deadline has passed',
        now > record_.deadline ? 'passed' : 'failed',
        now > record_.deadline
          ? `the deadline passed ${now - record_.deadline}s ago`
          : `${record_.deadline - now}s remain; cancelling earlier is rejected so a record ` +
            'already finalized remotely cannot be stranded by unilateral abandonment',
      );
    } catch {
      fail(checks, 'settlement exists', `no settlement named ${params.settlementId}`);
    }
  }

  consequences.push(
    'Cancelling ends the contest and settles nothing. The preceding entry stays in ' +
      'force, no instant becomes final, and a change the register has already made can ' +
      'still be admitted afterwards. It is not a rejection — the protocol defines none.',
  );

  return build(reader, 'cancelSettlement', from, checks, consequences, {
    signature: 'cancelSettlement(bytes32,bytes32)',
    types: ['bytes32', 'bytes32'],
    args: [params.settlementId, params.reasonHash],
    summary: `Cancel settlement ${params.settlementId}, closing the gap without admitting anything.`,
  });
}

// ------------------------------------------------------------------ internals

/**
 * Gate every builder on settlement conformance.
 *
 * Throws rather than recording a failure and continuing: without the
 * interface there is no operation to build, and the checks that follow would
 * call functions that revert.
 */
async function requireSettlement(
  reader: Erc8415Reader,
  kind: TransactionKind,
  checks: PreflightCheck[],
): Promise<void> {
  const conformance = await detectConformance(reader);
  try {
    requireSettlementConformance(reader, conformance);
    pass(checks, 'settlement conformance', 'the contract advertises 0xf4a7d71b');
  } catch {
    const check: PreflightCheck = {
      name: 'settlement conformance',
      outcome: 'failed',
      detail:
        'the contract does not advertise 0xf4a7d71b, so it has no settlement operations',
    };
    checks.push(check);
    throw new TransactionWouldRevertError(kind, [check]);
  }
}

function record(
  checks: PreflightCheck[],
  name: string,
  outcome: PreflightOutcome,
  detail: string,
): void {
  checks.push({ name, outcome, detail });
}

function pass(checks: PreflightCheck[], name: string, detail: string): void {
  record(checks, name, 'passed', detail);
}

function fail(checks: PreflightCheck[], name: string, detail: string): void {
  record(checks, name, 'failed', detail);
}

function build(
  reader: Erc8415Reader,
  kind: TransactionKind,
  from: Address,
  checks: readonly PreflightCheck[],
  consequences: readonly string[],
  call: {
    signature: string;
    types: readonly AbiType[];
    args: readonly AbiValue[];
    summary: string;
  },
): TransactionRequest {
  const blocking = checks.filter((check) => check.outcome === 'failed');
  if (blocking.length > 0) {
    throw new TransactionWouldRevertError(kind, blocking);
  }

  return {
    kind,
    to: reader.source.address,
    from,
    data: encodeCallWithTail(call.signature, call.types, call.args),
    value: '0x0',
    chainId: reader.source.chainId,
    summary: call.summary,
    preflight: {
      checks,
      blocking,
      unverifiable: checks.filter((check) => check.outcome === 'unverifiable'),
      consequences: [...consequences, NOTE_SNAPSHOT],
    },
  };
}
