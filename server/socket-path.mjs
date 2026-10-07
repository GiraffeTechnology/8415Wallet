/** Local IPC identity: only the service owner can replace a listener in its protected directory. */
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';
export async function protectSocketDirectory(path, uid = process.getuid?.()) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || !/^\/[A-Za-z0-9_./-]+\.sock$/.test(path) || Buffer.byteLength(path) > 100) throw Error('AUTH_SOCKET_PATH_REFUSED');
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, uid].includes(stat.uid) || stat.gid !== stat.uid ||
        (stat.mode & 0o6000) || ((stat.mode & 0o022) && !((stat.mode & 0o1000) && [0, uid].includes(stat.uid) && directory !== dirname(path))) ||
        await realpath(directory) !== directory) throw Error('AUTH_SOCKET_DIRECTORY_REFUSED');
    if (directory === dirname(path) && stat.uid !== uid) throw Error('AUTH_SOCKET_OWNER_REFUSED');
    if (directory === dirname(directory)) break;
  }
}
export async function protectSocket(path, uid = process.getuid?.()) {
  await protectSocketDirectory(path, uid);
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== uid || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o666) throw Error('AUTH_SOCKET_IDENTITY_REFUSED');
  return stat;
}
