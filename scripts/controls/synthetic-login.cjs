const { Wallet, getBytes } = require('ethers');
// Public fixture key 1, never a user credential. Local test signatures only.
const syntheticWallet = new Wallet(`0x${'0'.repeat(63)}1`);
async function installSyntheticLoginSigner(context) {
  await context.exposeFunction('__syntheticLoginSign', message => syntheticWallet.signMessage(getBytes(message)));
}
async function login(page) {
  if (await page.locator('#wallet-private').isVisible()) return;
  await page.click('#wallet-login');
  await page.waitForFunction(() => !document.getElementById('wallet-private').hidden);
  await page.waitForFunction(() => !document.getElementById('wallet-login').disabled);
}
module.exports = { syntheticWallet, installSyntheticLoginSigner, login };
