import { parseOperation, serializeOperation } from '../dist/browser/controls/operationJournal.js';

/** Same-origin, cross-tab CAS. No credentials, consent signatures or calldata are stored. */
export class BrowserPublicOperationStore {
  constructor(chainId, controller, actor) {
    if (!navigator.locks || !globalThis.isSecureContext) throw new Error('CONTROL_BROWSER_LOCKS_REQUIRED');
    this.key = `8415-operation-v1:${chainId}:${controller.toLowerCase()}:${actor.toLowerCase()}`;
  }
  async read() {
    const text = localStorage.getItem(this.key);
    return text === null ? null : parseOperation(text);
  }
  async compareAndSwap(expected, next) {
    return navigator.locks.request(this.key, { mode: 'exclusive' }, async () => {
      const before = await this.read();
      if ((before?.revision ?? null) !== expected) return false;
      if (next.revision !== (expected === null ? 0n : expected + 1n)) throw new Error('CONTROL_JOURNAL_REVISION_REFUSED');
      const text = serializeOperation(parseOperation(serializeOperation(next)));
      localStorage.setItem(this.key, text);
      if (localStorage.getItem(this.key) !== text) throw new Error('CONTROL_JOURNAL_COMMIT_REFUSED');
      return true;
    });
  }
}
