/** Replays every repository workflow shell step on an isolated Linux checkout. Never deploys. */
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (process.platform !== 'linux' || !/^v(?:22|24)\./.test(process.version)) throw Error('CI_LINUX_NODE_MATRIX_RUNTIME_REQUIRED');
if (process.argv[2] !== '--confirm-isolated-ci' || process.argv.length !== 3) throw Error('CI_EXPLICIT_ISOLATED_CHECKOUT_CONFIRMATION_REQUIRED');
const root = resolve(process.cwd());
if (root !== resolve(git(['rev-parse', '--show-toplevel'])) || git(['status', '--porcelain', '--untracked-files=no'])) throw Error('CI_CLEAN_EXACT_SOURCE_REQUIRED');
const head = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
const output = resolve(process.env.WALLET_CI_OUTPUT ?? join('/tmp', `8415wallet-ci-${head}-${process.version}`));
if (output === root || output.startsWith(root + '/')) throw Error('CI_EVIDENCE_MUST_BE_OUTSIDE_SOURCE');
mkdirSync(output, { recursive: true });
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8'); const lines = workflow.split('\n');
const stages = []; let name = '';
for (let i = 0; i < lines.length; i++) {
  const named = /^      - name: (.+)$/.exec(lines[i]); if (named) name = named[1];
  const run = /^        run: (.+)$/.exec(lines[i]); if (!run) continue;
  let command = run[1];
  if (command === '|') { const block = []; while (i + 1 < lines.length && /^(?:          |\s*$)/.test(lines[i + 1])) { i++; block.push(lines[i].replace(/^          /, '')); } command = block.join('\n').trimEnd(); }
  if (!name || !command || command.includes('${{')) throw Error('CI_UNSUPPORTED_WORKFLOW_RUN_SYNTAX');
  stages.push({ name, command });
}
if (stages.length < 21) throw Error('CI_WORKFLOW_STAGES_MISSING');
const receipt = { schema: '8415wallet-linux-ci/1', label: 'Isolated Linux CI; label host location separately. Not deployment or external hosted Actions.', source: { commit: head, tree }, node: process.version,
  workflowSha256: createHash('sha256').update(workflow).digest('hex'), startedAt: new Date().toISOString(), stages: [], outcome: 'running' };
const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(receipt, null, 2) + '\n'); save();
const environment = { ...process.env, npm_config_cache: process.env.npm_config_cache ?? join(output, 'npm-cache'),
  XDG_CACHE_HOME: join(output, 'xdg-cache'), XDG_CONFIG_HOME: join(output, 'xdg-config'), XDG_DATA_HOME: join(output, 'xdg-data') };
for (const [key, folder] of Object.entries({ LOGIN_UI_OUTPUT: 'login', AUTH_UI_OUTPUT: 'auth', I18N_UI_OUTPUT: 'i18n', APPROVED_UI_OUTPUT: 'approved', XIONGAN_SMOKE_OUTPUT: 'xiongan', ERC20_UI_OUTPUT: 'erc20', SETTLEMENT_UI_OUTPUT: 'settlement' })) environment[key] = join(output, 'browser-evidence', folder);
for (const path of [environment.npm_config_cache, environment.XDG_CACHE_HOME, environment.XDG_CONFIG_HOME, environment.XDG_DATA_HOME]) mkdirSync(path, { recursive: true });
for (const [index, stage] of stages.entries()) {
  const startedAt = new Date().toISOString(); console.log(`[${index + 1}/${stages.length}] ${stage.name}`);
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', stage.command], { cwd: root, env: environment, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  const log = `${String(index + 1).padStart(2, '0')}-${stage.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.log`;
  const bytes = (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? `\nExecution error: ${result.error.message}\n` : '');
  writeFileSync(join(output, log), bytes);
  receipt.stages.push({ ...stage, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal, status: result.status === 0 && !result.error ? 'passed' : 'failed', log, logSha256: createHash('sha256').update(bytes).digest('hex') });
  save();
}
receipt.finishedAt = new Date().toISOString(); receipt.outcome = receipt.stages.every(stage => stage.status === 'passed') ? 'passed' : 'failed';
receipt.sourceUnchanged = git(['rev-parse', 'HEAD']) === head && !git(['status', '--porcelain', '--untracked-files=no']);
if (!receipt.sourceUnchanged) receipt.outcome = 'failed';
save(); console.log(JSON.stringify({ outcome: receipt.outcome, source: receipt.source, stages: receipt.stages.length, result: join(output, 'result.json') }));
process.exitCode = receipt.outcome === 'passed' ? 0 : 1;
