import { encodeCall } from '../codec/abi.ts';
import type { Eip1193Provider } from '../adapters/signing/eip1193Signer.ts';
import { ResponsibilityControlClient, decodeControlWords, type ControlSubmission } from './client.ts';
import { controlHex, controlRpc, hashControlBytes, requireControlAdapter as check,
  verifyControlDeployment, type ControlDeploymentPin } from './authorization.ts';
import { address, uint, wordAddress, wordUint, callWords, submitFixed, receiptFixed,
  type FixedSubmission, type FixedReceipt } from './execution.ts';

export type ControlledAccount = { readonly owner: string; readonly account: string;
  readonly pin: ControlDeploymentPin; readonly controller: ControlDeploymentPin };

/** Account-only integration. No arbitrary execution, approval, delegation or secret import. */
export class ControlledAccountClient {
  readonly #provider: Eip1193Provider;
  readonly #control: ResponsibilityControlClient;
  constructor(provider: Eip1193Provider, controller: ControlDeploymentPin) {
    this.#provider = provider; this.#control = new ResponsibilityControlClient(provider, controller);
  }
  create(owner: string): Promise<ControlSubmission> {
    return this.#control.submit({ kind: 'create-account' }, owner);
  }
  async account(owner: string): Promise<ControlledAccount | null> {
    address(owner);
    const p = this.#control.deployment;
    await verifyControlDeployment(this.#provider, p);
    const read = async (to: string, data: string) => decodeControlWords(['address'], await callWords(this.#provider, to, data))[0] as string;
    const account = await read(p.controller, encodeCall('accountOf(address)', ['address'], [owner]));
    if (/^0x0+$/.test(account)) return null;
    const registered = decodeControlWords(['bool'], await callWords(this.#provider, p.controller,
      encodeCall('registeredAccount(address)', ['address'], [account])))[0];
    check(registered === true &&
      await read(account, encodeCall('owner()', [], [])) === owner.toLowerCase() &&
      await read(account, encodeCall('controller()', [], [])) === p.controller.toLowerCase(), 'CONTROL_ACCOUNT_BINDING_REFUSED');
    const code = await controlRpc(this.#provider, 'eth_getCode', [account, 'latest']);
    check(controlHex(code) && code.length > 2, 'CONTROL_ACCOUNT_CODE_REFUSED');
    // Registration comes from the pinned immutable factory/controller, not an
    // arbitrary caller's claim that an account has suitable methods.
    return { owner: owner.toLowerCase(), account, controller: p,
      pin: { chainId: p.chainId, controller: account, runtimeCodeHash: hashControlBytes(code) } };
  }
  async #token(pin: ControlDeploymentPin, tokenId: bigint): Promise<string> {
    uint(tokenId); check(pin.chainId === this.#control.deployment.chainId, 'CONTROL_CHAIN_MISMATCH');
    await verifyControlDeployment(this.#provider, pin);
    const supports = async (id: string) => decodeControlWords(['bool'], await callWords(this.#provider, pin.controller,
      encodeCall('supportsInterface(bytes4)', ['bytes4'], [id])))[0];
    check(await supports('0x01ffc9a7') === true && await supports('0x80ac58cd') === true &&
      await supports('0xffffffff') === false, 'CONTROL_TOKEN_INTERFACE_REFUSED');
    return decodeControlWords(['address'], await callWords(this.#provider, pin.controller,
      encodeCall('ownerOf(uint256)', ['uint256'], [tokenId])))[0] as string;
  }
  async deposit(owner: string, token: ControlDeploymentPin, tokenId: bigint): Promise<FixedSubmission> {
    const fixedToken = Object.freeze({ ...token });
    const account = await this.account(owner);
    check(account !== null, 'CONTROL_ACCOUNT_NOT_CREATED');
    check(await this.#token(fixedToken, tokenId) === owner.toLowerCase(), 'CONTROL_TOKEN_OWNER_REFUSED');
    return submitFixed(this.#provider, { pin: fixedToken, guards: [account.controller, account.pin], actor: owner,
      data: encodeCall('safeTransferFrom(address,address,uint256)', ['address', 'address', 'uint256'], [owner, account.account, tokenId]),
      value: 0n, event: { address: fixedToken.controller, signature: 'Transfer(address,address,uint256)',
        indexed: [wordAddress(owner), wordAddress(account.account), wordUint(tokenId)], dataHash: hashControlBytes('0x') } });
  }
  async withdraw(owner: string, token: ControlDeploymentPin, tokenId: bigint, destination: string): Promise<FixedSubmission> {
    address(destination); const fixedToken = Object.freeze({ ...token });
    const account = await this.account(owner);
    check(account !== null && destination.toLowerCase() !== account.account, 'CONTROL_ACCOUNT_OR_DESTINATION_REFUSED');
    check(await this.#token(fixedToken, tokenId) === account.account, 'CONTROL_TOKEN_OWNER_REFUSED');
    const allowed = decodeControlWords(['bool'], await callWords(this.#provider, account.controller.controller,
      encodeCall('standaloneWithdrawalAllowed(address,uint256)', ['address', 'uint256'], [fixedToken.controller, tokenId])))[0];
    check(allowed === true, 'CONTROL_ACTIVE_RESPONSIBILITY_REFUSED');
    // The account rechecks this policy atomically; the earlier read is only a snapshot.
    return submitFixed(this.#provider, { pin: account.pin, guards: [account.controller, fixedToken], actor: owner,
      data: encodeCall('withdrawStandalone(address,uint256,address)', ['address', 'uint256', 'address'], [fixedToken.controller, tokenId, destination]),
      value: 0n, event: { address: fixedToken.controller, signature: 'Transfer(address,address,uint256)',
        indexed: [wordAddress(account.account), wordAddress(destination), wordUint(tokenId)], dataHash: hashControlBytes('0x') } });
  }
  receipt(record: FixedSubmission, minimumConfirmations = 1n): Promise<FixedReceipt> {
    check(record.guards.some(p => p.chainId === this.#control.deployment.chainId &&
      p.controller.toLowerCase() === this.#control.deployment.controller.toLowerCase() &&
      p.runtimeCodeHash.toLowerCase() === this.#control.deployment.runtimeCodeHash.toLowerCase()), 'CONTROL_JOURNAL_DEPLOYMENT_REFUSED');
    return receiptFixed(this.#provider, record, minimumConfirmations);
  }
}
