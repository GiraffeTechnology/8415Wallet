import { encodeCall, encodeWords, REGISTER_ENTRY_TYPES, type AbiValue, type StaticType } from '../codec/abi.ts';
import { keccak256Utf8 } from '../codec/keccak.ts';
import type { Eip1193Provider } from '../adapters/signing/eip1193Signer.ts';
import type { Bytes32 } from '../sdk/types.ts';
import type { LinkedChainSnapshot, LinkedCompletionEvidence, LinkedControlReader } from '../sdk/linked.ts';
import { buildLinkedChainView } from '../wallet/linkedChainView.ts';
import { renderLinkedChain } from '../wallet/renderLinkedChain.ts';
import { ResponsibilityControlClient, decodeControlWords } from './client.ts';
import { controlHex, controlRpc, hashControlBytes, requireControlAdapter as requireValue,
  type ControlDeploymentPin } from './authorization.ts';

export const CONTROL_AUTHORITY_DISCLOSURE =
  'Entry-to-occurrence association is attested by the explicitly accepted registrar authority. ' +
  'This is not proof of legal identity, not inferred from equal addresses, and not ERC temporal finality.';

export type ControlProjectionObservation = {
  readonly instant: bigint; readonly owner: string; readonly holder: string;
  readonly protocolFinality: boolean; readonly openGapId: string; readonly contested: boolean;
  readonly freshness: 'not-evaluated'; readonly admittedVersion: bigint;
  readonly registerId: string; readonly verificationProfile: string;
};

/** Experimental pinned adapter; requires EIP-1898, never substitutes an indexer or older block. */
export class RpcResponsibilityControlReader implements LinkedControlReader {
  readonly #provider: Eip1193Provider;
  readonly #client: ResponsibilityControlClient;
  constructor(provider: Eip1193Provider, deployment: ControlDeploymentPin) {
    this.#provider = provider;
    this.#client = new ResponsibilityControlClient(provider, deployment);
  }
  async observe(sequenceId: Bytes32): Promise<{ snapshot: LinkedChainSnapshot; evidence: LinkedCompletionEvidence;
    projection: ControlProjectionObservation }> {
    const observed = await this.#client.snapshot(sequenceId);
    const s = observed.sequence;
    const pin = this.#client.deployment;
    const block = { blockHash: observed.blockHash, requireCanonical: true };
    const read = async (to: string, signature: string, args: readonly AbiValue[], types: readonly StaticType[], returns: readonly StaticType[]) =>
      decodeControlWords(returns, await controlRpc(this.#provider, 'eth_call', [{ to, data: encodeCall(signature, types, args) }, block]));
    const occurrence = (index: bigint) => hashControlBytes(encodeWords(['bytes32', 'bytes32', 'uint256'],
      [keccak256Utf8('8415Wallet/Occurrence/v1'), sequenceId, index]));
    const controlId = hashControlBytes(encodeWords(['uint256', 'address', 'bytes32'], [pin.chainId, pin.controller, sequenceId]));
    const asset = { chainId: pin.chainId, contract: s.token, tokenId: s.tokenId };
    // The snapshot describes the chain the contract still carries, so it is
    // anchored where that chain starts: the boundary, i.e. whoever the last
    // detached leg handed the token to. Anchoring it at the sequence's original
    // opening account instead would describe a first leg that is no longer there,
    // and every consumer would reject the snapshot for a broken predecessor.
    // With nothing detached the boundary IS the opening account, unchanged.
    const boundaryHolder = observed.legs[0]?.fromAccount ?? s.currentAccount;
    const snapshot: LinkedChainSnapshot = { asset, sequenceId, revision: s.revision,
      blockNumber: observed.blockNumber, blockHash: observed.blockHash,
      initialOccurrenceId: occurrence(observed.firstOccurrence),
      initialHolder: observed.firstOccurrence === 0n ? s.initialAccount : boundaryHolder,
      offChainDetached: observed.firstOccurrence,
      detachedCommitment: observed.sequence.detachedCommitment,
      legs: observed.legs.map((leg, i) => ({ id: leg.id,
        // The leg before the window has detached, so on chain it has no
        // predecessor to name. Its record is at the register.
        predecessorId: i === 0 ? null : observed.legs[i - 1]!.id,
        buyerOccurrenceId: occurrence(observed.firstOccurrence + BigInt(i) + 1n),
        seller: leg.fromAccount, buyer: leg.toAccount, termsHash: leg.termsHash,
        control: { controlId, acceptanceHash: leg.acceptanceHash }, outcome: leg.outcome })) };
    const code = await controlRpc(this.#provider, 'eth_getCode', [s.token, block]);
    requireValue(controlHex(code) && hashControlBytes(code) === s.tokenCodeHash, 'CONTROL_TOKEN_IDENTITY_CHANGED');
    const register = await read(s.token, 'registerId()', [], [], ['bytes32']);
    const profile = await read(s.token, 'verificationProfile()', [], [], ['bytes32']);
    requireValue(register[0] === s.registerId && profile[0] === s.verificationProfile, 'CONTROL_PROJECTION_IDENTITY_CHANGED');
    const owner = (await read(s.token, 'ownerOf(uint256)', [s.tokenId], ['uint256'], ['address']))[0] as string;
    // Call each protocol answer independently; no owner/finality/gap substitution.
    const entry = await read(s.token, 'entryAsOf(uint256,uint64)', [s.tokenId, observed.timestamp], ['uint256', 'uint64'], REGISTER_ENTRY_TYPES);
    const holder = (await read(s.token, 'holderAsOf(uint256,uint64)', [s.tokenId, observed.timestamp], ['uint256', 'uint64'], ['address']))[0] as string;
    const finality = (await read(s.token, 'isFinalAsOf(uint256,uint64)', [s.tokenId, observed.timestamp], ['uint256', 'uint64'], ['bool']))[0] as boolean;
    const openGapId = (await read(s.token, 'openGapOf(uint256)', [s.tokenId], ['uint256'], ['bytes32']))[0] as string;
    let contested = false;
    if (!/^0x0+$/.test(openGapId)) {
      const gap = await read(s.token, 'settlement(bytes32)', [openGapId], ['bytes32'],
        ['uint256', 'address', 'address', 'bytes32', 'uint64', 'uint64', 'uint8']);
      requireValue(gap[0] === s.tokenId && gap[6] === 1n, 'CONTROL_GAP_BINDING_REFUSED');
      contested = (gap[4] as bigint) <= observed.timestamp;
    }
    const binding = await read(pin.controller, 'admissionBinding(bytes32,uint64)', [sequenceId, entry[4]!], ['bytes32', 'uint64'], ['bool', 'uint256', 'bytes32']);
    let evidence: LinkedCompletionEvidence = { kind: 'unavailable' };
    if (binding[0] === true) {
      const index = binding[1] as bigint;
      // Occurrence 0 is the sequence's own initial account. Anything inside the
      // window resolves from it; a detached occurrence does not resolve here at
      // all, and is refused rather than guessed at.
      requireValue(index === 0n || (index >= observed.firstOccurrence &&
        index <= observed.firstOccurrence + BigInt(observed.legs.length)), 'CONTROL_OCCURRENCE_REFUSED');
      // The boundary occurrence is the account the window starts from - the
      // holder the last detached leg handed the token to. Beyond that the leg
      // is at the register, so the binding is refused rather than guessed.
      const boundary = observed.legs[0]?.fromAccount ?? s.currentAccount;
      const account = index === 0n && observed.firstOccurrence === 0n ? s.initialAccount
        : index === observed.firstOccurrence ? boundary
        : observed.legs[Number(index - observed.firstOccurrence - 1n)]!.toAccount;
      const immutableHash = hashControlBytes(encodeWords(REGISTER_ENTRY_TYPES.slice(0, 6), entry.slice(0, 6)));
      requireValue(binding[2] === immutableHash && account === holder && entry[3] === holder, 'CONTROL_ADMISSION_BINDING_REFUSED');
      // After a closed sequence permits a standalone withdrawal, this is historical
      // control state, not a claim that the token is still at its former cursor.
      if (owner === s.currentAccount) evidence = { kind: 'bound', asset, sequenceId, revision: s.revision,
        blockNumber: observed.blockNumber, blockHash: observed.blockHash,
        owner: { occurrenceId: occurrence(s.cursor), account: owner },
        admittedHolder: { occurrenceId: occurrence(index), account: holder }, protocolFinality: finality };
    }
    const end = await controlRpc(this.#provider, 'eth_getBlockByNumber', [`0x${observed.blockNumber.toString(16)}`, false]);
    requireValue(end !== null && typeof end === 'object' &&
      (end as Record<string, unknown>).hash === observed.blockHash, 'CONTROL_SNAPSHOT_REORGED');
    return { snapshot, evidence, projection: { instant: observed.timestamp, owner, holder, protocolFinality: finality,
      openGapId, contested, freshness: 'not-evaluated', admittedVersion: entry[4] as bigint,
      registerId: s.registerId, verificationProfile: s.verificationProfile } };
  }
  async render(sequenceId: Bytes32): Promise<string> {
    const { snapshot, evidence, projection } = await this.observe(sequenceId);
    const view = buildLinkedChainView(snapshot, evidence);
    return `${renderLinkedChain({ ...view, protocolFinality: projection.protocolFinality })}\n` +
      `Tradeable position: ${projection.owner}; confirmed holder: ${projection.holder}\n` +
      `Instant ${projection.instant}; contested: ${projection.contested}; freshness: not evaluated\n${CONTROL_AUTHORITY_DISCLOSURE}\n` +
      'Development implementation: unified tests, deployed UI evidence and independent audit are still required.';
  }
}
