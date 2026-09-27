const assert = require('node:assert/strict');
const hre = require('hardhat');

/**
 * Deployment and execution budgets, asserted rather than assumed.
 *
 * The controller sits at 97% of the EIP-170 contract size limit. Nothing was
 * watching that, so the first change that needed the remaining few hundred
 * bytes would have failed at deployment on a public chain — after passing every
 * other test, because a local chain is usually configured without the limit.
 *
 * These budgets exist to make that failure arrive here, in a named test, with
 * the number in the message. A change that needs more room is not wrong; it
 * needs a decision about where the room comes from, and this is the place that
 * asks for one.
 */
describe('Deployment and execution budgets', function () {
  this.timeout(180000);

  const EIP170 = 24576;
  // Reserve enough that a small addition fails here rather than on a chain.
  const MINIMUM_HEADROOM = 512;
  const CONTRACTS = ['RegisterProjectionReference', 'ResponsibilityController',
    'NativeResponsibilityPayments', 'ControlledWallet'];
  // Ceilings, not targets: roughly 25% above the worst case measured on this
  // tree, so they catch a regression that changes the order of a cost and leave
  // ordinary variation alone.
  const BUDGETS = [['open-sequence', 355_000n], ['forward', 525_000n], ['complete-prefix', 240_000n]];

  const runtimeSize = async (name) =>
    ((await hre.artifacts.readArtifact(name)).deployedBytecode.length - 2) / 2;

  it('every deployed contract fits the EIP-170 limit with room to change', async () => {
    const measured = [];
    for (const name of CONTRACTS) {
      const size = await runtimeSize(name);
      measured.push({ name, size, headroom: EIP170 - size });
    }
    for (const { name, size, headroom } of measured) {
      assert.ok(size <= EIP170,
        `${name} is ${size} bytes and cannot be deployed: the EIP-170 limit is ${EIP170}`);
      assert.ok(headroom >= MINIMUM_HEADROOM,
        `${name} is ${size} bytes, leaving ${headroom} bytes of headroom, below the ${MINIMUM_HEADROOM} reserved. ` +
        'Recover room before adding to it — see docs/reports/CONTRACT-SIZE-BUDGET.md for the measured options.');
    }
  });

  it('the controller no longer carries the payment adapter, and still carries the account', async () => {
    // `new` embeds a contract's whole creation bytecode in its creator. The
    // adapter was moved behind a pinned factory for 5,831 bytes; the account
    // stays, because only the controller may create one that names it, and
    // moving that would change what a registered account means.
    const controller = await runtimeSize('ResponsibilityController');
    const account = ((await hre.artifacts.readArtifact('ControlledWallet')).bytecode.length - 2) / 2;
    const payments = ((await hre.artifacts.readArtifact('NativeResponsibilityPayments')).bytecode.length - 2) / 2;

    assert.ok(controller > account,
      'the account creation bytecode is still embedded, so the controller must exceed it');
    assert.ok(controller < 24576 - payments,
      `the controller is ${controller} bytes: re-embedding the ${payments}-byte adapter would not fit, ` +
      'which is the saving this arrangement exists to keep');
  });

  it('a controller refuses any factory but the one its code hash names', async () => {
    const [deployer] = await hre.ethers.getSigners();
    const factory = await (await hre.ethers.getContractFactory('NativePaymentsFactory', deployer)).deploy();
    await factory.waitForDeployment();
    const address = await factory.getAddress();
    const codeHash = hre.ethers.keccak256(await hre.ethers.provider.getCode(address));
    const controllerFactory = await hre.ethers.getContractFactory('ResponsibilityController', deployer);

    // A hash that does not match the code at that address is refused, so a
    // controller cannot be deployed pointing at something it did not name.
    await assert.rejects(controllerFactory.deploy(address, hre.ethers.id('not-this-factory')), /InvalidInput/);
    // The empty hash is refused too, so the check cannot be opted out of.
    await assert.rejects(controllerFactory.deploy(address, hre.ethers.ZeroHash), /InvalidInput/);
    // An address with no code hashes to zero, and is refused by the same rule.
    await assert.rejects(controllerFactory.deploy(deployer.address, codeHash), /InvalidInput/);

    const controller = await controllerFactory.deploy(address, codeHash);
    await controller.waitForDeployment();
    assert.equal(await controller.paymentsFactory(), address);
    assert.equal(await controller.paymentsFactoryCodeHash(), codeHash);

    // What it adopts comes from that factory, and is bound to this controller.
    await (await controller.createNativePayments()).wait();
    const adapter = await controller.nativePayments();
    const adopted = await hre.ethers.getContractAt('NativeResponsibilityPayments', adapter);
    assert.equal(await adopted.controller(), await controller.getAddress());
    // Adoption is one-shot: a second call cannot replace a live adapter.
    await assert.rejects(controller.createNativePayments.staticCall(), /InvalidInput/);
  });

  it('the core write path stays within its measured gas budget', async () => {
    const { createScenario } = require('../scripts/controls/scenario-kit.cjs');
    const used = new Map();
    const k = await createScenario({
      ethers: hre.ethers, provider: hre.ethers.provider,
      signers: await hre.ethers.getSigners(),
      artifact: (name) => hre.artifacts.readArtifact(name),
      record: async (r) => {
        if (r.kind !== 'transaction') return;
        const previous = used.get(r.label) ?? 0n;
        const gas = BigInt(r.gasUsed);
        if (gas > previous) used.set(r.label, gas);
      },
    });

    const s = await k.open();
    await k.forward(s, 0, 1);
    await k.forward(s, 1, 2);
    await k.admit(s, 1);
    await k.complete(s, 1);

    for (const [label, gas] of [...used].sort()) process.stdout.write(`      ${label} ${gas}\n`);
    for (const [label, ceiling] of BUDGETS) {
      const gas = used.get(label);
      assert.ok(gas !== undefined, `${label} was never executed, so its budget proves nothing`);
      assert.ok(gas <= ceiling, `${label} used ${gas} gas, above its ${ceiling} budget`);
    }
  });
});
