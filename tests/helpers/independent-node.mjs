/** A private exact-byte Node copy for installation fixtures, never a host runtime change. */
import assert from 'node:assert/strict';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

export async function independentNode() {
  const source = await realpath(process.execPath), original = await lstat(source);
  assert.ok(original.isFile(), 'the running Node must resolve to a regular executable');
  const sourceHash = await hashFile(source);
  const root = await mkdtemp(join(tmpdir(), 'wallet-fixture-node-'));
  const node = join(root, 'node');
  try {
    await chmod(root, 0o700);
    await copyFile(source, node, constants.COPYFILE_EXCL);
    await chmod(node, 0o755);
    const stat = await lstat(node);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.nlink, 1);
    assert.equal(stat.uid, process.getuid());
    assert.equal(stat.gid, process.getgid());
    assert.equal(stat.mode & 0o7777, 0o755);
    assert.ok(stat.dev !== original.dev || stat.ino !== original.ino, 'fixture must not share the source inode');
    assert.equal(await realpath(node), node);
    assert.equal(await hashFile(node), sourceHash, 'copied runtime must match the running Node exactly');
    assert.equal(await hashFile(source), sourceHash, 'source runtime must remain unchanged during copying');
    return { node, uid: stat.uid, sha256: sourceHash, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
