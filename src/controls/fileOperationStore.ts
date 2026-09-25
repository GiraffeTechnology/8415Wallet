import * as fs from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireControlAdapter as check, ControlAdapterError } from './authorization.ts';
import { parseOperation, serializeOperation, type OperationState, type PublicOperationStore } from './operationJournal.ts';

/**
 * Local public journal, not a secret store or authorization source. One directory
 * per account/controller shared by all app instances. A stale lock fails closed;
 * no automatic lock stealing or cached-success recovery. Caller secures parent ACL.
 */
export class FilePublicOperationStore implements PublicOperationStore {
  readonly #root: string; readonly #identity: string;
  constructor(directory: string) {
    this.#root = resolve(directory);
    const stat = fs.lstatSync(this.#root);
    check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(this.#root) === this.#root, 'CONTROL_JOURNAL_ROOT_REFUSED');
    this.#identity = `${stat.dev}:${stat.ino}`;
    // Reject a host/filesystem without a real directory flush BEFORE a send can
    // be authorized. Windows Node's ordinary fs API may not provide this primitive.
    this.#syncRoot();
  }
  #syncRoot(): void {
    this.#checkRoot(); let fd: number | undefined;
    try {
      fd = fs.openSync(this.#root, fs.constants.O_RDONLY);
      const s = fs.fstatSync(fd);
      check(s.isDirectory() && `${s.dev}:${s.ino}` === this.#identity, 'CONTROL_JOURNAL_ROOT_REFUSED');
      fs.fsyncSync(fd); this.#checkRoot();
    } catch { throw new ControlAdapterError('CONTROL_JOURNAL_DURABILITY_UNAVAILABLE'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  #checkRoot(): void {
    const s = fs.lstatSync(this.#root);
    check(s.isDirectory() && !s.isSymbolicLink() && fs.realpathSync(this.#root) === this.#root &&
      `${s.dev}:${s.ino}` === this.#identity, 'CONTROL_JOURNAL_ROOT_REFUSED');
  }
  #read(): OperationState | null {
    this.#checkRoot(); const file = join(this.#root, 'operation.json');
    let s: fs.Stats;
    try { s = fs.lstatSync(file); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new ControlAdapterError('CONTROL_JOURNAL_READ_REFUSED');
    }
    check(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= 16384, 'CONTROL_JOURNAL_FILE_REFUSED');
    const fd = fs.openSync(file, 'r');
    try {
      const actual = fs.fstatSync(fd);
      check(actual.ino === s.ino && actual.dev === s.dev && actual.nlink === 1 && actual.size <= 16384, 'CONTROL_JOURNAL_FILE_REFUSED');
      const text = fs.readFileSync(fd, 'utf8');
      this.#checkRoot(); return parseOperation(text);
    } finally { fs.closeSync(fd); }
  }
  async read(): Promise<OperationState | null> {
    try { return this.#read(); } catch { throw new ControlAdapterError('CONTROL_JOURNAL_READ_REFUSED'); }
  }
  async compareAndSwap(expected: bigint | null, next: OperationState): Promise<boolean> {
    const safe = parseOperation(serializeOperation(next));
    check(safe.revision === (expected === null ? 0n : expected + 1n), 'CONTROL_JOURNAL_REVISION_REFUSED');
    this.#checkRoot();
    const lock = join(this.#root, 'operation.lock');
    let lockFd: number;
    try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch { throw new ControlAdapterError('CONTROL_JOURNAL_LOCKED'); }
    const temporary = join(this.#root, `operation-${randomUUID()}.tmp`);
    let created = false;
    try {
      const current = this.#read();
      if ((current?.revision ?? null) !== expected) return false;
      const fd = fs.openSync(temporary, 'wx', 0o600); created = true;
      try { fs.writeFileSync(fd, serializeOperation(safe), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.#checkRoot(); fs.renameSync(temporary, join(this.#root, 'operation.json')); created = false;
      this.#syncRoot();
      const back = this.#read();
      check(back !== null && serializeOperation(back) === serializeOperation(safe), 'CONTROL_JOURNAL_COMMIT_REFUSED');
      return true;
    } catch { throw new ControlAdapterError('CONTROL_JOURNAL_COMMIT_REFUSED'); }
    finally {
      // Only exact files created by this operation; never recursively deletes a root.
      try { if (created) fs.unlinkSync(temporary); }
      finally { fs.closeSync(lockFd); this.#checkRoot(); fs.unlinkSync(lock); this.#syncRoot(); }
    }
  }
}
