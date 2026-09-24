import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contracts');

interface SolcOutput {
  errors?: { severity: string; formattedMessage: string }[];
  contracts: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>>;
}

/** Compile every contract in contracts/ once, and fail loudly on any error. */
export const compileContracts = (): SolcOutput => {
  const solc = require('solc') as { compile(input: string, options?: unknown): string };
  const sources: Record<string, { content: string }> = {};
  for (const file of readdirSync(contractsDir).filter((name) => name.endsWith('.sol'))) {
    sources[file] = { content: readFileSync(join(contractsDir, file), 'utf8') };
  }

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input))) as SolcOutput;
  const fatal = (output.errors ?? []).filter((error) => error.severity === 'error');
  if (fatal.length > 0) {
    throw new Error(`solidity compilation failed:\n${fatal.map((e) => e.formattedMessage).join('\n')}`);
  }
  return output;
};

export const abiOf = (output: SolcOutput, file: string, name: string): unknown[] => {
  const contract = output.contracts[file]?.[name];
  if (contract === undefined) throw new Error(`no contract ${name} in ${file}`);
  return contract.abi;
};
