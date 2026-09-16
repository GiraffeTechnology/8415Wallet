import type { Address, Bytes32, Instant, TokenId } from '../sdk/types.ts';

/**
 * Command-line arguments for the reference client.
 *
 * Without `--rpc` the client runs the bundled in-memory scenarios, which is
 * what makes `npm run wallet` a demo anyone can run. With it, the same views
 * read a live contract — the adapters were always able to; nothing connected
 * them to a command line, so the library was usable against a chain and the
 * client was not.
 */

export type CliOptions = {
  readonly rpc: string | undefined;
  readonly contract: Address | undefined;
  readonly chainId: bigint | undefined;
  readonly token: TokenId | undefined;
  readonly account: Address | undefined;
  readonly instant: Instant | undefined;
  readonly watchtower: Address | undefined;
  readonly assetId: Bytes32 | undefined;
  readonly help: boolean;
};

export const USAGE = `8415wallet — reference client for ERC-8415 asynchronous register projection

  npm run wallet                      run the bundled in-memory scenarios
  npm run wallet -- --rpc <url> --contract <address> [options]

Required to read a live contract:
  --rpc <url>            JSON-RPC endpoint
  --contract <address>   the ERC-8415 conforming ERC-721 contract

Options:
  --token <id>           the token to inspect; omit with --account to discover
  --account <address>    report settlement authority for this account, and
                         discover the tokens it holds when --token is omitted
  --instant <seconds>    the instant to ask about, as uint64 Unix seconds;
                         defaults to the latest block's timestamp
  --chain-id <id>        chain id for provenance labelling (default 1)
  --watchtower <address> a watchtower freshness layer to read alongside
  --asset-id <bytes32>   the feed identifier on that watchtower
  --help

The pairing of a watchtower feed to a projection is never verified on chain.
Supplying --asset-id asserts it; the wallet labels it as asserted.`;

export function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`${arg} needs a value`);
    }
    values.set(arg.slice(2), next);
    index += 1;
  }

  const address = (key: string): Address | undefined => {
    const raw = values.get(key);
    if (raw === undefined) return undefined;
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error(`--${key} is not an address: ${raw}`);
    return raw.toLowerCase();
  };
  const integer = (key: string): bigint | undefined => {
    const raw = values.get(key);
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw)) throw new Error(`--${key} is not a whole number: ${raw}`);
    return BigInt(raw);
  };

  const assetId = values.get('asset-id');
  if (assetId !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(assetId)) {
    throw new Error(`--asset-id is not a 32-byte value: ${assetId}`);
  }

  return {
    rpc: values.get('rpc'),
    contract: address('contract'),
    chainId: integer('chain-id'),
    token: integer('token'),
    account: address('account'),
    instant: integer('instant'),
    watchtower: address('watchtower'),
    assetId: assetId?.toLowerCase(),
    help,
  };
}

/** Reject a combination that cannot be acted on, before any network call. */
export function validate(options: CliOptions): void {
  if (options.rpc === undefined) return;
  if (options.contract === undefined) {
    throw new Error('--rpc needs --contract: there is no default deployment');
  }
  if (options.token === undefined && options.account === undefined) {
    throw new Error('supply --token, or --account to discover the tokens it holds');
  }
  if ((options.watchtower === undefined) !== (options.assetId === undefined)) {
    throw new Error('--watchtower and --asset-id go together');
  }
}
