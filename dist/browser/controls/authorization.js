import { encodeCall, encodeCallWithTail, encodeWords } from "../codec/abi.js";
import { keccak256, keccak256Utf8 } from "../codec/keccak.js";
export const FORWARD_FIELDS = [
    { name: 'sequenceId', type: 'bytes32' }, { name: 'expectedRevision', type: 'uint256' },
    { name: 'legId', type: 'bytes32' }, { name: 'token', type: 'address' },
    { name: 'tokenId', type: 'uint256' }, { name: 'fromAccount', type: 'address' },
    { name: 'toAccount', type: 'address' }, { name: 'termsHash', type: 'bytes32' },
    { name: 'inheritedHash', type: 'bytes32' }, { name: 'returnAuthority', type: 'address' },
    { name: 'returnConditionHash', type: 'bytes32' }, { name: 'evidenceAuthority', type: 'address' },
    { name: 'deadline', type: 'uint64' }, { name: 'recipientNonce', type: 'uint256' },
    { name: 'paymentAdapter', type: 'address' }, { name: 'paymentAmount', type: 'uint256' },
];
for (const field of FORWARD_FIELDS)
    Object.freeze(field);
Object.freeze(FORWARD_FIELDS);
export const FORWARD_TYPE = `ForwardConsent(${FORWARD_FIELDS.map(f => `${f.type} ${f.name}`).join(',')})`;
export const FORWARD_TUPLE = `(${FORWARD_FIELDS.map(f => f.type).join(',')})`;
const FORWARD_TYPES = FORWARD_FIELDS.map(f => f.type);
const DOMAIN_FIELDS = [
    { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
];
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
const NAME = '8415Wallet ResponsibilityControls';
export class ControlAdapterError extends Error {
    code;
    constructor(code) { super(code); this.name = 'ControlAdapterError'; this.code = code; }
}
export function requireControlAdapter(ok, code) {
    if (!ok)
        throw new ControlAdapterError(code);
}
export function controlHex(value, bytes) {
    return typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value) &&
        (bytes === undefined || value.length === 2 + bytes * 2);
}
/** Some genuine EIP-1193 wallets return a number for the pending nonce only. */
export function controlPendingNonce(value) {
    if (typeof value === 'number') {
        requireControlAdapter(Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0), 'CONTROL_RPC_QUANTITY_REFUSED');
        return BigInt(value);
    }
    requireControlAdapter(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value), 'CONTROL_RPC_QUANTITY_REFUSED');
    return BigInt(value);
}
export function hashControlBytes(value) {
    requireControlAdapter(controlHex(value), 'CONTROL_HEX_REFUSED');
    const bytes = Uint8Array.from(value.slice(2).match(/../g) ?? [], pair => Number.parseInt(pair, 16));
    return `0x${Array.from(keccak256(bytes), b => b.toString(16).padStart(2, '0')).join('')}`;
}
function address(value) {
    return controlHex(value, 20) && !/^0x0+$/i.test(value);
}
export function validateControlPin(pin) {
    requireControlAdapter(typeof pin.chainId === 'bigint' && pin.chainId > 0n && pin.chainId < 1n << 256n &&
        address(pin.controller) && controlHex(pin.runtimeCodeHash, 32) && !/^0x0+$/.test(pin.runtimeCodeHash), 'CONTROL_DEPLOYMENT_PIN_REFUSED');
}
export function validateForwardConsent(consent) {
    requireControlAdapter(Object.keys(consent).length === FORWARD_FIELDS.length &&
        Object.keys(consent).every(k => FORWARD_FIELDS.some(f => f.name === k)), 'CONTROL_CONSENT_SCHEMA_REFUSED');
    for (const field of FORWARD_FIELDS) {
        const value = consent[field.name];
        if (field.type === 'address')
            requireControlAdapter(field.name === 'paymentAdapter' ? controlHex(value, 20) : address(value), 'CONTROL_CONSENT_ADDRESS_REFUSED');
        else if (field.type === 'bytes32')
            requireControlAdapter(controlHex(value, 32) && !/^0x0+$/i.test(value), 'CONTROL_CONSENT_HASH_REFUSED');
        else
            requireControlAdapter(typeof value === 'bigint' && value >= 0n &&
                value < 1n << (field.type === 'uint64' ? 64n : 256n), 'CONTROL_CONSENT_INTEGER_REFUSED');
    }
    requireControlAdapter(consent.fromAccount.toLowerCase() !== consent.toAccount.toLowerCase(), 'CONTROL_SELF_FORWARD_REFUSED');
    requireControlAdapter(/^0x0+$/i.test(consent.paymentAdapter) === (consent.paymentAmount === 0n), 'CONTROL_PAYMENT_PROFILE_REFUSED');
}
export function forwardConsentValues(consent) {
    validateForwardConsent(consent);
    return FORWARD_FIELDS.map(f => consent[f.name]);
}
export function controlDomainSeparator(pin) {
    validateControlPin(pin);
    return hashControlBytes(encodeWords(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [keccak256Utf8(DOMAIN_TYPE), keccak256Utf8(NAME), keccak256Utf8('1'), pin.chainId, pin.controller]));
}
export function forwardConsentDigest(pin, consent) {
    const structHash = hashControlBytes(encodeWords(['bytes32', ...FORWARD_TYPES], [keccak256Utf8(FORWARD_TYPE), ...forwardConsentValues(consent)]));
    return hashControlBytes(`0x1901${controlDomainSeparator(pin).slice(2)}${structHash.slice(2)}`);
}
export function forwardTypedData(pin, consent) {
    validateControlPin(pin);
    validateForwardConsent(consent);
    const message = Object.fromEntries(FORWARD_FIELDS.map(f => {
        const value = consent[f.name];
        return [f.name, typeof value === 'bigint' ? value.toString() : value.toLowerCase()];
    }));
    return { types: { EIP712Domain: DOMAIN_FIELDS.map(f => ({ ...f })), ForwardConsent: FORWARD_FIELDS.map(f => ({ ...f })) },
        primaryType: 'ForwardConsent', domain: { name: NAME, version: '1', chainId: pin.chainId.toString(),
            verifyingContract: pin.controller.toLowerCase() }, message };
}
export function encodeForward(consent, signature) {
    requireControlAdapter(controlHex(signature) && signature.length > 2 && signature.length <= 8194, 'CONTROL_SIGNATURE_SHAPE_REFUSED');
    return encodeCallWithTail(`forward(${FORWARD_TUPLE},bytes)`, [...FORWARD_TYPES, 'bytes'], [...forwardConsentValues(consent), signature]);
}
/** Errors deliberately do not echo provider payloads, endpoints, signatures or credentials. */
export async function controlRpc(provider, method, params) {
    // Timeout does not cancel a wallet prompt or prove a transaction was not sent.
    // Callers must reconcile uncertain submissions, never automatically resubmit.
    const interactive = method === 'eth_sendTransaction' || method === 'eth_signTypedData_v4' || method === 'eth_requestAccounts';
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(() => provider.request({ method, params })).catch(() => {
                throw new ControlAdapterError(interactive ? 'CONTROL_PROVIDER_OUTCOME_UNCERTAIN' : 'CONTROL_RPC_REFUSED');
            }),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new ControlAdapterError(interactive ? 'CONTROL_PROVIDER_OUTCOME_UNCERTAIN' : 'CONTROL_RPC_TIMEOUT')), interactive ? 180_000 : 30_000);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
export async function verifyControlDeployment(provider, pin) {
    validateControlPin(pin);
    const chain = await controlRpc(provider, 'eth_chainId', []);
    requireControlAdapter(typeof chain === 'string' && /^0x[0-9a-f]+$/i.test(chain) && BigInt(chain) === pin.chainId, 'CONTROL_CHAIN_MISMATCH');
    const code = await controlRpc(provider, 'eth_getCode', [pin.controller, 'latest']);
    requireControlAdapter(controlHex(code) && code.length > 2 && hashControlBytes(code) === pin.runtimeCodeHash.toLowerCase(), 'CONTROL_RUNTIME_PIN_MISMATCH');
}
async function selectedAccount(provider, expected) {
    requireControlAdapter(address(expected), 'CONTROL_SIGNER_REFUSED');
    const accounts = await controlRpc(provider, 'eth_accounts', []);
    requireControlAdapter(Array.isArray(accounts) && typeof accounts[0] === 'string' &&
        accounts[0].toLowerCase() === expected.toLowerCase(), 'CONTROL_SIGNER_MISMATCH');
}
/** Explicit user-driven signing only. Returns in memory; no logging/persistence/raw-key support. */
export async function signForwardConsent(provider, pin, consent, recipientOwner) {
    // Copy before the first await so a caller cannot mutate the displayed intent mid-prompt.
    const frozenPin = Object.freeze({ ...pin });
    const frozen = Object.freeze({ ...consent });
    const typed = forwardTypedData(frozenPin, frozen);
    const payload = JSON.stringify(typed);
    await verifyControlDeployment(provider, frozenPin);
    await selectedAccount(provider, recipientOwner);
    const registered = await controlRpc(provider, 'eth_call', [{ to: frozenPin.controller,
            data: encodeCall('registeredAccount(address)', ['address'], [frozen.toAccount]) }, 'latest']);
    requireControlAdapter(registered === `0x${'0'.repeat(63)}1`, 'CONTROL_RECIPIENT_UNREGISTERED');
    const owner = await controlRpc(provider, 'eth_call', [{ to: frozen.toAccount, data: encodeCall('owner()', [], []) }, 'latest']);
    requireControlAdapter(controlHex(owner, 32) && owner.toLowerCase() === `0x${'0'.repeat(24)}${recipientOwner.slice(2).toLowerCase()}`, 'CONTROL_RECIPIENT_OWNER_MISMATCH');
    const nonce = await controlRpc(provider, 'eth_call', [{ to: frozenPin.controller,
            data: encodeCall('recipientNonces(address)', ['address'], [recipientOwner]) }, 'latest']);
    requireControlAdapter(controlHex(nonce, 32) && BigInt(nonce) === frozen.recipientNonce, 'CONTROL_CONSENT_NONCE_STALE');
    const header = await controlRpc(provider, 'eth_getBlockByNumber', ['latest', false]);
    const timestamp = header && typeof header === 'object' ? header.timestamp : undefined;
    requireControlAdapter(typeof timestamp === 'string' && /^0x[0-9a-f]+$/i.test(timestamp) &&
        BigInt(timestamp) <= frozen.deadline, 'CONTROL_CONSENT_EXPIRED');
    const signature = await controlRpc(provider, 'eth_signTypedData_v4', [recipientOwner, payload]);
    requireControlAdapter(controlHex(signature) && signature.length > 2 && signature.length <= 8194, 'CONTROL_SIGNATURE_SHAPE_REFUSED');
    await verifyControlDeployment(provider, frozenPin);
    await selectedAccount(provider, recipientOwner);
    const valid = await controlRpc(provider, 'eth_call', [{ to: frozenPin.controller,
            data: encodeCallWithTail(`validateRecipientSignature(${FORWARD_TUPLE},bytes)`, [...FORWARD_TYPES, 'bytes'], [...forwardConsentValues(frozen), signature]) }, 'latest']);
    requireControlAdapter(valid === `0x${'0'.repeat(63)}1`, 'CONTROL_SIGNATURE_INVALID');
    return signature;
}
