// Bundle the existing lockfile-pinned ethers ESM distribution locally; no CDN or new service.
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
export function buildLoginVendor(root = process.cwd()) {
  mkdirSync(resolve(root, 'dist/browser/vendor'), { recursive: true });
  copyFileSync(resolve(root, 'node_modules/ethers/dist/ethers.min.js'), resolve(root, 'dist/browser/vendor/ethers.js'));
  copyFileSync(resolve(root, 'node_modules/ethers/LICENSE.md'), resolve(root, 'dist/browser/vendor/ETHERS-LICENSE.md'));
}
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) buildLoginVendor();
