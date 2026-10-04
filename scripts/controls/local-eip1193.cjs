// Local EVM test adapter only. Hardhat's typed SolidityError is not an EIP-1193
// ProviderRpcError; translate that proved VM revert to the provider code used
// by the production read transport. Never infer a revert from an error message.
const { SolidityError } = require('hardhat/internal/hardhat-network/stack-traces/solidity-errors');
async function requestLocalEip1193(provider, request) {
  try { return await provider.request(request); }
  catch (error) {
    if (request.method === 'eth_call' && error instanceof SolidityError) {
      throw Object.assign(new Error('Local EVM execution reverted'), { code: 3 });
    }
    throw error;
  }
}
module.exports = { requestLocalEip1193 };
