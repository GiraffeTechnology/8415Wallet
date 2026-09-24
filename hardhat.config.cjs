require('@nomicfoundation/hardhat-ethers');

/**
 * Solidity build, kept apart from the TypeScript suite.
 *
 * `npm test` runs the wallet and Kit suites under node:test. This config
 * drives the contracts: the escrow, and the ERC-8415 reference implementation
 * it is tested against. They are separate commands because they are separate
 * toolchains, and `npm run verify` runs both.
 */
module.exports = {
  solidity: {
    version: '0.8.26',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  paths: {
    sources: './contracts',
    tests: './test-evm',
    cache: './cache',
    artifacts: './artifacts',
  },
};
