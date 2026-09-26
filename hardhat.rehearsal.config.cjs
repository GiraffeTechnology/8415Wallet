const base=require('./hardhat.config.cjs');

// Rehearsal only: the public-testnet runner accepts Sepolia and Hoodi chain ids,
// so a loopback chain has to answer with one to exercise that exact path. This
// config is never used by `npm test`, `npm run test:evm` or a public run.
const chainId=Number(process.env.WALLET_REHEARSAL_CHAIN_ID??'11155111');
if(![11155111,560048].includes(chainId))throw new Error('REHEARSAL_CHAIN_REFUSED');
module.exports={...base,networks:{...base.networks,hardhat:{...base.networks?.hardhat,chainId,
  // A public run pays real testnet gas; keep the rehearsal on the same rules.
  initialBaseFeePerGas:1000000000,hardfork:'cancun'}}};
