import { bindingDigest, sha256Hex } from './binding.ts';
import { admitted, refused, type ProofContext, type ProofMaterial, type ProofProfile, type ProofVerdict } from './profile.ts';
import type { RemoteChainAdapter } from '../ports.ts';

/**
 * A stand-in for a succinct verifier.
 *
 * It is a mock, and says so: the "proof" is a digest over the verifying key,
 * the accepted state root and the admission binding, so a real verifier can
 * replace it without anything above this file changing. What it does exercise
 * for real is the property that matters at this layer — a proof is bound to
 * one admission and will not verify against another.
 *
 * It does not, and a real verifier would not, establish that the registrar
 * signed truthfully. That is a separate trust assumption.
 */
export class MockZkProofProfile implements ProofProfile {
  readonly id = 'zk/mock/v1';
  readonly #adapter: RemoteChainAdapter;
  readonly #verifyingKey: string;

  constructor(adapter: RemoteChainAdapter, verifyingKey = 'vk:erc8415:mock') {
    this.#adapter = adapter;
    this.#verifyingKey = verifyingKey;
  }

  /** The proof a prover holding this verifying key would produce. */
  prove(material: Pick<ProofMaterial, 'remoteHeight'>, context: ProofContext): string {
    const root = this.#adapter.stateRootAt(material.remoteHeight);
    if (root === undefined) throw new Error(`no accepted state root at height ${material.remoteHeight}`);
    return this.#expected(root, bindingDigest(context.binding, context.candidate));
  }

  verify(material: ProofMaterial, context: ProofContext): ProofVerdict {
    const root = this.#adapter.stateRootAt(material.remoteHeight);
    if (root === undefined) {
      return refused(`no accepted state root at remote height ${material.remoteHeight}`);
    }

    const supplied = material.payload['proof'];
    if (typeof supplied !== 'string') {
      return refused('proof payload carries no proof');
    }

    const expected = this.#expected(root, bindingDigest(context.binding, context.candidate));
    if (supplied !== expected) {
      return refused('the proof does not verify against this admission binding');
    }
    return admitted;
  }

  #expected(root: string, digest: string): string {
    return sha256Hex(`${this.#verifyingKey}|${root}|${digest}`);
  }
}
