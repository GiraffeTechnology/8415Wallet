import type { Eip1193Provider } from '../adapters/signing/eip1193Signer.ts';
import { keccak256Utf8 } from '../codec/keccak.ts';
import { ResponsibilityControlClient, type ControlAction, type ControlReceipt } from './client.ts';
import { ControlledAccountClient } from './accounts.ts';
import { NativeResponsibilityPaymentClient } from './payments.ts';
import { ForwardConsentReview } from './consentReview.ts';
import { RpcResponsibilityControlReader } from './view.ts';
import { address, proveSupersededNonce, type FixedReceipt, type SupersededNonceProof } from './execution.ts';
import { ControlAdapterError, controlHex, requireControlAdapter as check, type ControlDeploymentPin, type ForwardConsent } from './authorization.ts';
import { parseOperation, serializeOperation, sameDeployment, type OperationState, type PublicOperationStore,
  type WalletSubmission } from './operationJournal.ts';

export type WalletOperation =
  | { readonly kind: 'control'; readonly action: ControlAction }
  | { readonly kind: 'deposit'; readonly token: ControlDeploymentPin; readonly tokenId: bigint }
  | { readonly kind: 'standalone-withdraw'; readonly token: ControlDeploymentPin; readonly tokenId: bigint; readonly destination: string }
  | { readonly kind: 'reserve-payment'; readonly consent: ForwardConsent }
  | { readonly kind: 'cancel-reservation'; readonly sequenceId: string; readonly legId: string }
  | { readonly kind: 'allocate'; readonly sequenceId: string; readonly legIndex: bigint }
  | { readonly kind: 'payout'; readonly sequenceId: string; readonly legId: string };

/** Additive application workflow; original WalletSession readers/transactions remain independent. */
export class ResponsibilityWalletSession {
  readonly controls: ResponsibilityControlClient;
  readonly accounts: ControlledAccountClient;
  readonly consent: ForwardConsentReview;
  readonly reader: RpcResponsibilityControlReader;
  readonly payments: NativeResponsibilityPaymentClient | null;
  readonly #store: PublicOperationStore;
  readonly #provider: Eip1193Provider;
  readonly #actor: string;
  #busy = false;
  #beforeSend: ((record: WalletSubmission) => Promise<void>) | null = null;
  constructor(provider: Eip1193Provider, pin: ControlDeploymentPin, actor: string, store: PublicOperationStore,
    payment: ControlDeploymentPin | null = null) {
    address(actor); this.#actor = actor.toLowerCase(); this.#store = store; this.#provider = provider;
    const beforeSend = async (record: WalletSubmission) => {
      check(this.#beforeSend !== null, 'CONTROL_SESSION_EXECUTE_REQUIRED'); await this.#beforeSend(record);
    };
    this.controls = new ResponsibilityControlClient(provider, pin, beforeSend);
    this.accounts = new ControlledAccountClient(provider, pin, beforeSend); this.consent = new ForwardConsentReview(provider, pin);
    this.reader = new RpcResponsibilityControlReader(provider, pin);
    this.payments = payment === null ? null : new NativeResponsibilityPaymentClient(provider, pin, payment, beforeSend);
  }
  async #state(): Promise<OperationState> {
    let s = await this.#store.read();
    if (s === null) {
      const initial: OperationState = { schema: '8415-operation/1', revision: 0n, status: 'idle',
        deployment: this.controls.deployment, actor: this.#actor, requestDigest: null, submission: null };
      check(await this.#store.compareAndSwap(null, initial), 'CONTROL_OPERATION_CONCURRENT'); s = initial;
    }
    s = parseOperation(serializeOperation(s));
    check(sameDeployment(s.deployment, this.controls.deployment) && s.actor === this.#actor, 'CONTROL_JOURNAL_SESSION_REFUSED');
    return s;
  }
  async status(): Promise<OperationState> { return structuredClone(await this.#state()); }
  /** Recover a crash BEFORE the durable send template existed, never a prompted send.
   * CAS also invalidates a still-running predecessor: its beforeSend cannot commit.
   */
  async discardUnpreparedIntent(): Promise<void> {
    return this.#exclusive(async () => {
      const s = await this.#state();
      check(s.status === 'outcome-unknown' && s.submission === null, 'CONTROL_PREPARED_INTENT_CANNOT_DISCARD');
      check(await this.#store.compareAndSwap(s.revision, { ...s, revision: s.revision + 1n,
        status: 'idle', requestDigest: null, submission: null }), 'CONTROL_OPERATION_CONCURRENT');
    });
  }
  async #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    check(!this.#busy, 'CONTROL_OPERATION_BUSY'); this.#busy = true;
    try { return await fn(); } finally { this.#busy = false; }
  }
  async execute(input: WalletOperation): Promise<WalletSubmission> {
    const operation = structuredClone(input);
    return this.#exclusive(async () => {
      const current = await this.#state();
      check(current.status === 'idle', 'CONTROL_RECONCILIATION_REQUIRED');
      if (['reserve-payment', 'cancel-reservation', 'allocate', 'payout'].includes(operation.kind)) check(this.payments !== null, 'CONTROL_PAYMENT_NOT_CONFIGURED');
      // Persist uncertainty BEFORE any external prompt. No plaintext consent/calldata goes to disk.
      const requestDigest = keccak256Utf8(JSON.stringify(operation, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value));
      let reserved: OperationState = { ...current, revision: current.revision + 1n, status: 'outcome-unknown', requestDigest, submission: null };
      check(await this.#store.compareAndSwap(current.revision, reserved), 'CONTROL_OPERATION_CONCURRENT');
      let prepared = false;
      this.#beforeSend = async template => {
        check(!prepared, 'CONTROL_DUPLICATE_SEND_REFUSED');
        const next: OperationState = { ...reserved, revision: reserved.revision + 1n, submission: template };
        check(await this.#store.compareAndSwap(reserved.revision, next), 'CONTROL_OPERATION_CONCURRENT');
        reserved = next; prepared = true;
      };
      try {
      let record: WalletSubmission;
      switch (operation.kind) {
        case 'control': record = await this.controls.submit(operation.action, this.#actor); break;
        case 'deposit': record = await this.accounts.deposit(this.#actor, operation.token, operation.tokenId); break;
        case 'standalone-withdraw': record = await this.accounts.withdraw(this.#actor, operation.token, operation.tokenId, operation.destination); break;
        case 'reserve-payment': record = await this.payments!.reserve(operation.consent, this.#actor); break;
        case 'cancel-reservation': record = await this.payments!.cancelReservation(operation.sequenceId, operation.legId, this.#actor); break;
        case 'allocate': record = await this.payments!.allocate(operation.sequenceId, operation.legIndex, this.#actor); break;
        case 'payout': record = await this.payments!.withdraw(operation.sequenceId, operation.legId, this.#actor); break;
        default: throw new ControlAdapterError('CONTROL_ACTION_REFUSED');
      }
      const submitted: OperationState = { ...reserved, revision: reserved.revision + 1n, status: 'submitted', submission: record };
      // If persistence fails, throw a sanitized uncertainty code, not success or an automatic retry.
      check(await this.#store.compareAndSwap(reserved.revision, submitted), 'CONTROL_SUBMISSION_PERSISTENCE_UNCERTAIN');
      return structuredClone(record);
      } catch (error) {
        // Only a failure BEFORE the beforeSend hook proves no wallet send was invoked.
        if (!prepared) await this.#store.compareAndSwap(reserved.revision, { ...reserved, revision: reserved.revision + 1n,
          status: 'idle', requestDigest: null, submission: null });
        throw error;
      } finally { this.#beforeSend = null; }
    });
  }
  /** Recover a hash from genuine wallet activity without re-signing or trusting its claimed outcome. */
  async recoverTransactionHash(transactionHash: string, minimumConfirmations = 1n): Promise<void> {
    return this.#exclusive(async () => {
      check(controlHex(transactionHash, 32) && !/^0x0+$/.test(transactionHash), 'CONTROL_TRANSACTION_HASH_REFUSED');
      const s = await this.#state();
      check(s.status === 'outcome-unknown' && s.submission !== null, 'CONTROL_PREPARED_TRANSACTION_REQUIRED');
      const record = { ...s.submission, transactionHash: transactionHash.toLowerCase() };
      const receipt = await this.#receipt(record, minimumConfirmations);
      // Pending/absent hashes have not proved any binding. Do not accept them as recovery.
      check(['confirmed', 'confirming', 'reverted'].includes(receipt.state), 'CONTROL_RECOVERY_BINDING_NOT_OBSERVED');
      check(await this.#store.compareAndSwap(s.revision, { ...s, revision: s.revision + 1n, status: 'submitted', submission: record }),
        'CONTROL_OPERATION_CONCURRENT');
    });
  }
  /** Explicitly resolve a different confirmed transaction consuming this exact
   * nonce. Never labels the original operation successful and never sends again.
   */
  async acknowledgeSupersededNonce(replacementHash: string, minimumConfirmations = 1n): Promise<SupersededNonceProof> {
    return this.#exclusive(async () => {
      const s = await this.#state();
      check(s.status !== 'idle' && s.submission !== null, 'CONTROL_PREPARED_TRANSACTION_REQUIRED');
      const r = s.submission;
      const proof = await proveSupersededNonce(this.#provider, { pin: r.schema === '8415-control-submission/1' ? r.deployment : r.pin,
        actor: r.actor, nonce: r.nonce, value: r.schema === '8415-control-submission/1' ? 0n : r.value,
        calldataHash: r.calldataHash, transactionHash: r.transactionHash }, replacementHash, minimumConfirmations);
      check(await this.#store.compareAndSwap(s.revision, { ...s, revision: s.revision + 1n,
        status: 'idle', requestDigest: null, submission: null }), 'CONTROL_OPERATION_CONCURRENT');
      return proof;
    });
  }
  async #receipt(record: WalletSubmission, confirmations: bigint): Promise<ControlReceipt | FixedReceipt> {
    return record.schema === '8415-control-submission/1' ? this.controls.receipt(record, confirmations) :
      this.payments !== null && record.event.signature !== 'Transfer(address,address,uint256)'
        ? this.payments.receipt(record, confirmations) : this.accounts.receipt(record, confirmations);
  }
  /** No sends. Even previously confirmed records are rechecked after a restart/reorg. */
  async reconcile(minimumConfirmations = 1n): Promise<ControlReceipt | FixedReceipt> {
    return this.#exclusive(async () => {
      const s = await this.#state();
      check(s.status === 'submitted' && s.submission !== null, 'CONTROL_KNOWN_SUBMISSION_REQUIRED');
      const record = s.submission;
      const receipt = await this.#receipt(record, minimumConfirmations);
      // Do not clear automatically. UI must explicitly acknowledge a freshly rechecked terminal outcome.
      return receipt;
    });
  }
  async acknowledgeTerminal(transactionHash: string, minimumConfirmations = 1n): Promise<void> {
    // Reconcile is a separate read; CAS below prevents clearing a concurrently replaced record.
    const before = await this.#state();
    check(before.submission?.transactionHash === transactionHash, 'CONTROL_TRANSACTION_BINDING_REFUSED');
    const receipt = await this.reconcile(minimumConfirmations);
    check(receipt.transactionHash === transactionHash && (receipt.state === 'confirmed' || receipt.state === 'reverted'),
      'CONTROL_TERMINAL_RECEIPT_REQUIRED');
    check(await this.#store.compareAndSwap(before.revision, { ...before, revision: before.revision + 1n, status: 'idle',
      requestDigest: null, submission: null }), 'CONTROL_OPERATION_CONCURRENT');
  }
}
