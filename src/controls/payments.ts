import { encodeCall, encodeWords } from '../codec/abi.ts';
import type { Eip1193Provider } from '../adapters/signing/eip1193Signer.ts';
import { ResponsibilityControlClient, decodeControlWords } from './client.ts';
import { controlHex, controlRpc, hashControlBytes, requireControlAdapter as check, verifyControlDeployment,
  type ControlDeploymentPin } from './authorization.ts';
import { callWords, uint, wordAddress, submitFixed, receiptFixed, type FixedSubmission, type FixedReceipt } from './execution.ts';

const PAYMENT_STATES = ['unfunded', 'funded', 'settlement-due', 'refund-due', 'settled', 'refunded'] as const;
const OUTCOME_NAMES = ['active', 'completed', 'returning', 'returned'] as const;
export type PaymentSnapshot = { readonly sequenceId: string; readonly legId: string;
  readonly payer: string; readonly payee: string; readonly amount: bigint; readonly state: typeof PAYMENT_STATES[number] };

/** Separate optional adapter. Payment never authorizes forward, completion or callback. */
export class NativeResponsibilityPaymentClient {
  readonly #provider: Eip1193Provider;
  readonly #control: ResponsibilityControlClient;
  readonly #pin: ControlDeploymentPin;
  readonly #beforeSend: ((template: FixedSubmission) => Promise<void>) | undefined;
  constructor(provider: Eip1193Provider, controller: ControlDeploymentPin, payment: ControlDeploymentPin,
    beforeSend?: (template: FixedSubmission) => Promise<void>) {
    this.#provider = provider; this.#control = new ResponsibilityControlClient(provider, controller);
    this.#pin = Object.freeze({ ...payment });
    this.#beforeSend = beforeSend;
    check(controller.chainId === payment.chainId, 'CONTROL_CHAIN_MISMATCH');
  }
  async #verify(): Promise<void> {
    await verifyControlDeployment(this.#provider, this.#control.deployment);
    await verifyControlDeployment(this.#provider, this.#pin);
    const controller = decodeControlWords(['address'], await callWords(this.#provider, this.#pin.controller,
      encodeCall('controller()', [], [])))[0];
    check(controller === this.#control.deployment.controller.toLowerCase(), 'CONTROL_PAYMENT_CONTROLLER_REFUSED');
  }
  async read(sequenceId: string, legId: string): Promise<PaymentSnapshot> {
    check(controlHex(sequenceId, 32) && controlHex(legId, 32), 'CONTROL_PAYMENT_ID_REFUSED');
    await this.#verify();
    const r = decodeControlWords(['address', 'address', 'uint256', 'uint8'], await callWords(this.#provider, this.#pin.controller,
      encodeCall('payment(bytes32,bytes32)', ['bytes32', 'bytes32'], [sequenceId, legId])));
    const state = PAYMENT_STATES[Number(r[3])]; check(state !== undefined, 'CONTROL_PAYMENT_STATE_REFUSED');
    return { sequenceId, legId, payer: r[0] as string, payee: r[1] as string, amount: r[2] as bigint, state };
  }
  /**
   * How the leg ended, asked of the controller by id.
   *
   * Not read from the leg: a completed leg has detached from the chain by the
   * time its payment settles, so there is no leg left to read. The controller
   * keeps the terminal fact for exactly this reason.
   */
  async #outcomeOf(sequenceId: string, legId: string): Promise<typeof OUTCOME_NAMES[number]> {
    const r = decodeControlWords(['uint8'], await callWords(this.#provider, this.#control.deployment.controller,
      encodeCall('legTerminalOutcome(bytes32,bytes32)', ['bytes32', 'bytes32'], [sequenceId, legId])));
    const name = OUTCOME_NAMES[Number(r[0])];
    check(name !== undefined, 'CONTROL_PAYMENT_OUTCOME_REFUSED');
    return name!;
  }

  /** A combined UI must use the same canonical block as the responsibility view. */
  async readAt(sequenceId: string, legId: string, blockHash: string): Promise<PaymentSnapshot> {
    check(controlHex(sequenceId, 32) && controlHex(legId, 32) && controlHex(blockHash, 32), 'CONTROL_PAYMENT_ID_REFUSED');
    await this.#verify(); const block = { blockHash, requireCanonical: true };
    for (const pin of [this.#pin, this.#control.deployment]) {
      const code = await controlRpc(this.#provider, 'eth_getCode', [pin.controller, block]);
      check(controlHex(code) && hashControlBytes(code) === pin.runtimeCodeHash.toLowerCase(), 'CONTROL_RUNTIME_PIN_MISMATCH');
    }
    const r = decodeControlWords(['address', 'address', 'uint256', 'uint8'], await callWords(this.#provider, this.#pin.controller,
      encodeCall('payment(bytes32,bytes32)', ['bytes32', 'bytes32'], [sequenceId, legId]), block));
    const state = PAYMENT_STATES[Number(r[3])]; check(state !== undefined, 'CONTROL_PAYMENT_STATE_REFUSED');
    return { sequenceId, legId, payer: r[0] as string, payee: r[1] as string, amount: r[2] as bigint, state };
  }
  async termsHash(token: string, tokenId: bigint, from: string, to: string, amount: bigint): Promise<string> {
    await this.#verify(); uint(amount, true);
    return decodeControlWords(['bytes32'], await callWords(this.#provider, this.#pin.controller,
      encodeCall('termsHash(address,uint256,address,address,uint256)', ['address', 'uint256', 'address', 'address', 'uint256'],
        [token, tokenId, from, to, amount])))[0] as string;
  }
  async fund(sequenceId: string, legIndex: bigint, payer: string, amount: bigint): Promise<FixedSubmission> {
    uint(legIndex); uint(amount, true); await this.#verify();
    const snapshot = await this.#control.snapshot(sequenceId);
    // legIndex is an absolute occurrence, which is what the contract indexes by;
    // the snapshot carries only the window. Reading it window-relative would
    // check the terms and payer of one leg and fund a different one.
    const within = legIndex - snapshot.firstOccurrence;
    check(legIndex >= snapshot.firstOccurrence && within < BigInt(snapshot.legs.length),
      'CONTROL_LEG_INDEX_REFUSED');
    const leg = snapshot.legs[Number(within)]!;
    check(leg.outcome === 'active' && !snapshot.sequence.closed, 'CONTROL_PAYMENT_OUTCOME_REFUSED');
    const owner = async (account: string) => decodeControlWords(['address'], await callWords(this.#provider, account,
      encodeCall('owner()', [], [])))[0] as string;
    const [expectedPayer, payee] = await Promise.all([owner(leg.toAccount), owner(leg.fromAccount)]);
    check(expectedPayer === payer.toLowerCase(), 'CONTROL_PAYMENT_PAYER_REFUSED');
    check(await this.termsHash(snapshot.sequence.token, snapshot.sequence.tokenId, leg.fromAccount, leg.toAccount, amount) === leg.termsHash,
      'CONTROL_PAYMENT_TERMS_REFUSED');
    return submitFixed(this.#provider, { pin: this.#pin, guards: [this.#control.deployment], actor: payer,
      data: encodeCall('fund(bytes32,uint256)', ['bytes32', 'uint256'], [sequenceId, legIndex]), value: amount,
      event: { address: this.#pin.controller, signature: 'Funded(bytes32,bytes32,address,address,uint256)',
        indexed: [sequenceId, leg.id, wordAddress(payer)], dataHash: hashControlBytes(encodeWords(['address', 'uint256'], [payee, amount])) } }, this.#beforeSend);
  }
  /**
   * Allocate by leg id, not position. A completed leg detaches from the chain
   * before its payment settles, so the position may no longer resolve; the
   * controller still answers how the leg ended.
   */
  async allocate(sequenceId: string, legId: string, actor: string): Promise<FixedSubmission> {
    check(controlHex(sequenceId, 32) && controlHex(legId, 32), 'CONTROL_PAYMENT_ID_REFUSED');
    await this.#verify();
    const p = await this.read(sequenceId, legId);
    const outcome = await this.#outcomeOf(sequenceId, legId);
    check(p.state === 'funded' && (outcome === 'completed' || outcome === 'returned'), 'CONTROL_PAYMENT_OUTCOME_REFUSED');
    const settled = outcome === 'completed';
    const leg = { id: legId.toLowerCase() };
    return submitFixed(this.#provider, { pin: this.#pin, guards: [this.#control.deployment], actor,
      data: encodeCall('allocate(bytes32,bytes32)', ['bytes32', 'bytes32'], [sequenceId, legId]), value: 0n,
      event: { address: this.#pin.controller, signature: 'Allocated(bytes32,bytes32,address,uint256,uint8)',
        indexed: [sequenceId, leg.id, wordAddress(settled ? p.payee : p.payer)],
        dataHash: hashControlBytes(encodeWords(['uint256', 'uint8'], [p.amount, settled ? 2n : 3n])) } }, this.#beforeSend);
  }
  async withdraw(sequenceId: string, legId: string, actor: string): Promise<FixedSubmission> {
    const p = await this.read(sequenceId, legId);
    check(p.state === 'settlement-due' || p.state === 'refund-due', 'CONTROL_PAYMENT_NOT_DUE');
    const settled = p.state === 'settlement-due';
    check(actor.toLowerCase() === (settled ? p.payee : p.payer), 'CONTROL_PAYMENT_RECIPIENT_REFUSED');
    return submitFixed(this.#provider, { pin: this.#pin, guards: [this.#control.deployment], actor,
      data: encodeCall('withdraw(bytes32,bytes32)', ['bytes32', 'bytes32'], [sequenceId, legId]), value: 0n,
      event: { address: this.#pin.controller, signature: 'Withdrawn(bytes32,bytes32,address,uint256,uint8)',
        indexed: [sequenceId, legId, wordAddress(actor)],
        dataHash: hashControlBytes(encodeWords(['uint256', 'uint8'], [p.amount, settled ? 4n : 5n])) } }, this.#beforeSend);
  }
  receipt(record: FixedSubmission, minimumConfirmations = 1n): Promise<FixedReceipt> {
    check(record.pin.chainId === this.#pin.chainId && record.pin.controller.toLowerCase() === this.#pin.controller.toLowerCase() &&
      record.pin.runtimeCodeHash.toLowerCase() === this.#pin.runtimeCodeHash.toLowerCase(), 'CONTROL_JOURNAL_DEPLOYMENT_REFUSED');
    return receiptFixed(this.#provider, record, minimumConfirmations);
  }
}
