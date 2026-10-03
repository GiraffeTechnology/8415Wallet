import { encodeCall, encodeWords } from "../codec/abi.js";
import { keccak256Utf8 } from "../codec/keccak.js";
import { ResponsibilityControlClient, decodeControlWords } from "./client.js";
import { address, callWords, uint } from "./execution.js";
import { controlHex, forwardConsentDigest, hashControlBytes, requireControlAdapter as check, signForwardConsent, validateForwardConsent, FORWARD_FIELDS, FORWARD_TUPLE, forwardConsentValues } from "./authorization.js";
const PAYMENT_TYPE = '8415Wallet/NativePayment/v1(uint256 chainId,address adapter,address controller,address token,uint256 tokenId,address fromAccount,address toAccount,uint256 amount)';
function textBody(text) {
    check(typeof text === 'string' && new TextEncoder().encode(text).length > 0 &&
        new TextEncoder().encode(text).length <= 16384 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), 'CONTROL_TERMS_TEXT_REFUSED');
}
function verifyTerms(pin, token, tokenId, d) {
    textBody(d.returnConditionText);
    check(keccak256Utf8(d.returnConditionText) === d.returnConditionHash.toLowerCase(), 'CONTROL_CONDITION_DOCUMENT_MISMATCH');
    let hash;
    if (d.terms.scheme === 'utf8-keccak256') {
        textBody(d.terms.text);
        hash = keccak256Utf8(d.terms.text);
    }
    else {
        check(d.terms.scheme === 'native-payment-v1', 'CONTROL_TERMS_SCHEME_REFUSED');
        address(d.terms.adapter);
        uint(d.terms.amount, true);
        hash = hashControlBytes(encodeWords(['bytes32', 'uint256', 'address', 'address', 'address', 'uint256', 'address', 'address', 'uint256'], [keccak256Utf8(PAYMENT_TYPE), pin.chainId, d.terms.adapter, pin.controller, token, tokenId, d.fromAccount, d.toAccount, d.terms.amount]));
    }
    check(hash === d.termsHash.toLowerCase(), 'CONTROL_TERMS_DOCUMENT_MISMATCH');
}
function freezeReview(review) {
    Object.freeze(review.consent);
    Object.freeze(review.incoming.terms);
    Object.freeze(review.incoming);
    for (const leg of review.inherited) {
        Object.freeze(leg.terms);
        Object.freeze(leg);
    }
    Object.freeze(review.inherited);
    return Object.freeze(review);
}
/** A review is a session-local capability, not a caller-supplied boolean or signature cache. */
export class ForwardConsentReview {
    #provider;
    #control;
    #reviews = new WeakSet();
    #signing = false;
    constructor(provider, pin) {
        this.#provider = provider;
        this.#control = new ResponsibilityControlClient(provider, pin);
    }
    async #current(consent, recipientOwner) {
        validateForwardConsent(consent);
        address(recipientOwner);
        const s = await this.#control.snapshot(consent.sequenceId);
        check(!s.sequence.closed && s.sequence.callbackRootPlusOne === 0n &&
            s.sequence.cursor === s.firstOccurrence + BigInt(s.legs.length) &&
            s.sequence.revision === consent.expectedRevision && s.sequence.token === consent.token.toLowerCase() &&
            s.sequence.tokenId === consent.tokenId && s.sequence.currentAccount === consent.fromAccount.toLowerCase() &&
            s.sequence.evidenceAuthority === consent.evidenceAuthority.toLowerCase() && s.inheritedHash === consent.inheritedHash.toLowerCase() &&
            !s.legs.some(l => l.id === consent.legId.toLowerCase()) && s.timestamp <= consent.deadline, 'CONTROL_REVIEW_STALE');
        const block = { blockHash: s.blockHash, requireCanonical: true };
        const pin = this.#control.deployment;
        const registered = decodeControlWords(['bool'], await callWords(this.#provider, pin.controller, encodeCall('registeredAccount(address)', ['address'], [consent.toAccount]), block))[0];
        check(registered === true, 'CONTROL_RECIPIENT_UNREGISTERED');
        const owner = decodeControlWords(['address'], await callWords(this.#provider, consent.toAccount, encodeCall('owner()', [], []), block))[0];
        const nonce = decodeControlWords(['uint256'], await callWords(this.#provider, pin.controller, encodeCall('recipientNonces(address)', ['address'], [recipientOwner]), block))[0];
        check(owner === recipientOwner.toLowerCase() && nonce === consent.recipientNonce, 'CONTROL_REVIEW_RECIPIENT_STALE');
        const authority = decodeControlWords(['bool'], await callWords(this.#provider, consent.token, encodeCall('isSettlementAuthority(uint256,address)', ['uint256', 'address'], [consent.tokenId, consent.evidenceAuthority]), block))[0];
        check(authority === true, 'CONTROL_EVIDENCE_AUTHORITY_STALE');
        if (consent.paymentAmount > 0n) {
            const adapter = decodeControlWords(['address'], await callWords(this.#provider, pin.controller, encodeCall('nativePayments()', [], []), block))[0];
            check(adapter === consent.paymentAdapter.toLowerCase(), 'CONTROL_PAYMENT_ADAPTER_REFUSED');
        }
        const eligible = decodeControlWords(['bool'], await callWords(this.#provider, pin.controller, encodeCall(`checkForwardEligibility(${FORWARD_TUPLE})`, FORWARD_FIELDS.map(f => f.type), forwardConsentValues(consent)), block))[0];
        check(eligible === true, 'CONTROL_FORWARD_NOT_EXECUTABLE');
        return s;
    }
    async prepare(input, owner, documents) {
        const consent = structuredClone(input);
        const docs = structuredClone(documents);
        check(Array.isArray(docs.inherited) && docs.inherited.length <= 128, 'CONTROL_DISCLOSURE_SCOPE_REFUSED');
        const s = await this.#current(consent, owner);
        const active = s.legs.filter(l => l.outcome === 'active');
        check(docs.inherited.length === active.length && new Set(docs.inherited.map(d => d.legId.toLowerCase())).size === active.length, 'CONTROL_DISCLOSURE_SCOPE_REFUSED');
        const inherited = active.map(leg => {
            const doc = docs.inherited.find(d => d.legId.toLowerCase() === leg.id);
            check(doc !== undefined, 'CONTROL_INHERITED_TERMS_MISSING');
            return { legId: leg.id, fromAccount: leg.fromAccount, toAccount: leg.toAccount, termsHash: leg.termsHash,
                terms: doc.terms, returnAuthority: leg.returnAuthority, returnConditionHash: leg.returnConditionHash,
                returnConditionText: doc.returnConditionText };
        });
        const incoming = { legId: consent.legId, fromAccount: consent.fromAccount, toAccount: consent.toAccount,
            termsHash: consent.termsHash, terms: docs.incoming.terms, returnAuthority: consent.returnAuthority,
            returnConditionHash: consent.returnConditionHash, returnConditionText: docs.incoming.returnConditionText };
        for (const d of [incoming, ...inherited])
            verifyTerms(this.#control.deployment, consent.token, consent.tokenId, d);
        check(incoming.terms.scheme === 'native-payment-v1'
            ? incoming.terms.adapter.toLowerCase() === consent.paymentAdapter.toLowerCase() && incoming.terms.amount === consent.paymentAmount
            : consent.paymentAmount === 0n, 'CONTROL_PAYMENT_DISCLOSURE_MISMATCH');
        const review = freezeReview({ schema: '8415-forward-review/1', digest: forwardConsentDigest(this.#control.deployment, consent),
            recipientOwner: owner.toLowerCase(), consent, observedBlockHash: s.blockHash, inherited, incoming,
            completionRule: 'Both actual owner and admitted holder must reach this buyer occurrence or later in the accepted chain. Completed prefixes detach permanently; later returns cannot cross them.',
            authorityNotice: 'The accepted registrar associates admitted entries with occurrences. The named return authority attests the accepted trigger. Neither is proof of legal title. Protocol delay alone does not authorize return.',
            paymentNotice: 'Payment is optional. A native-payment acceptance requires the original buyer to reserve its exact amount before forwarding; the control consumes that reservation atomically with token movement. Completion and return remain independent; terminal payment is withdrawn separately. Invalidate the recipient nonce before cancelling an unused reservation.' });
        this.#reviews.add(review);
        return review;
    }
    async accept(review, acknowledgedDigest) {
        check(this.#reviews.has(review) && controlHex(acknowledgedDigest, 32) && acknowledgedDigest === review.digest, 'CONTROL_REVIEW_ACKNOWLEDGEMENT_REFUSED');
        check(!this.#signing, 'CONTROL_OPERATION_BUSY');
        this.#reviews.delete(review);
        this.#signing = true;
        try {
            await this.#current(review.consent, review.recipientOwner);
            const signature = await signForwardConsent(this.#provider, this.#control.deployment, review.consent, review.recipientOwner);
            await this.#current(review.consent, review.recipientOwner);
            // Raw consent remains in memory only. A used/failed review cannot be signed again.
            return signature;
        }
        finally {
            this.#signing = false;
        }
    }
}
