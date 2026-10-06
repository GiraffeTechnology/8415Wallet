/** Existing synthetic safety journeys use the real screen navigation introduced
 * by the approved UI. Never remove hidden/inert, call app internals, or bypass login. */
function installScreenNavigation(page) {
  const original = Object.fromEntries(['click', 'fill', 'check', 'selectOption', 'setInputFiles'].map(name => [name, page[name].bind(page)]));
  async function navigate(route) {
    const direct = page.locator(`.nav-item[data-route="${route}"]`);
    if (await direct.count() && await direct.isVisible()) { await direct.click(); return; }
    if (route === 'advanced') { await page.locator('.nav-item[data-route="settings"]').click(); }
    else if (route === 'review') { await navigate('transfer'); }
    else { await page.locator('.nav-item[data-route="overview"]').click(); }
    const button = page.locator(`[data-route="${route}"]:visible`).first();
    await button.click();
  }
  async function reveal(selector) {
    const target = page.locator(selector).first(); if (!await target.count()) return;
    const context = await target.evaluate(node => ({
      locked: !!document.getElementById('wallet-private')?.hidden,
      page: node.closest('[data-page]')?.dataset.page,
      login: !!node.closest('#login-panel'),
      connection: !!node.closest('#asset-connection'),
      visible: !!node.getClientRects().length,
    }));
    if (context.locked) return; // Security tests must still encounter the genuine display lock.
    if (!context.visible) {
      if (context.login) await navigate('settings');
      else if (context.page) await navigate(context.page);
      else if (context.connection) await navigate('transfer');
    }
    if (context.connection && !await page.locator('#asset-connection').evaluate(node => node.open)) await page.locator('#asset-connection > summary').click();
  }
  for (const name of Object.keys(original)) page[name] = async (selector, ...args) => { await reveal(selector); return original[name](selector, ...args); };
  return page;
}
module.exports = { installScreenNavigation };
