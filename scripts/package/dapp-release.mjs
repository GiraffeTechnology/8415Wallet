import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function walk(root, directory = '') {
  return readdirSync(join(root, directory)).sort().flatMap(name => {
    const file = directory ? `${directory}/${name}` : name;
    const stat = lstatSync(join(root, file));
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`DAPP_UNSAFE_FILE: ${file}`);
    return stat.isDirectory() ? walk(root, file) : [file];
  });
}
export function deterministicArchive(root, output) {
  // Also check the tree before tar can follow an unexpected filesystem entry.
  walk(root);
  const tar = execFileSync('tar', ['--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0',
    '--numeric-owner', '--format=ustar', '--mode=u+rwX,go+rX,go-w', '-cf', '-', '-C', root, '.'],
  { maxBuffer: 1 << 28 });
  const gzip = execFileSync('gzip', ['-9', '-n'], { input: tar, maxBuffer: 1 << 28 });
  writeFileSync(output, gzip);
  return sha256(gzip);
}

export function captureSource(root) {
  const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
  if (resolve(git(['rev-parse', '--show-toplevel'])) !== resolve(root)) throw new Error('DAPP_SOURCE_REPOSITORY_REQUIRED');
  const commit = git(['rev-parse', 'HEAD']);
  const commitTree = git(['rev-parse', 'HEAD^{tree}']);
  const indexTree = git(['write-tree']);
  const temporary = mkdtempSync(join(tmpdir(), 'wallet-source-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') };
  try {
    git(['read-tree', indexTree], { env });
    // Only tracked or explicitly staged additions belong to a source export.
    // Never sweep untracked local configuration or credentials into an archive.
    git(['add', '--update', '--', '.'], { env });
    const tree = git(['write-tree'], { env });
    const entries = git(['ls-tree', '-r', tree]).split('\n').map(line => {
      const match = line.match(/^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/);
      if (!match || /[\x00-\x1f\\]/.test(match[3]) || match[3].startsWith('"')) throw new Error('DAPP_SOURCE_PATH_REFUSED');
      return { mode: match[1], object: match[2], path: match[3] };
    });
    const files = {};
    for (const entry of entries) files[entry.path] = sha256(execFileSync('git', ['cat-file', 'blob', entry.object], { cwd: root, maxBuffer: 1 << 26 }));
    return { commit, commitTree, indexTree, tree, dirty: tree !== commitTree,
      identityVerification: 'local-git-commit-and-content-tree', files, entries };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function exportSource(root, source, output) {
  const temporary = mkdtempSync(join(tmpdir(), 'wallet-source-export-'));
  try {
    for (const entry of source.entries) {
      const target = join(temporary, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, execFileSync('git', ['cat-file', 'blob', entry.object], { cwd: root, maxBuffer: 1 << 26 }));
      chmodSync(target, entry.mode === '100755' ? 0o755 : 0o644);
    }
    return deterministicArchive(temporary, output);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}


export function stagePublicWeb(root, source, stage) {
  const entries = source.entries.filter(entry => entry.path.startsWith('web/'));
  const paths = new Set(entries.map(entry => entry.path));
  for (const file of walk(root, 'web')) {
    if (!paths.has(file)) throw new Error(`DAPP_UNTRACKED_SOURCE_STAGE_REQUIRED: ${file}`);
  }
  const extensions = new Set(['.html', '.mjs', '.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2', '.ttf']);
  for (const entry of entries) {
    if (entry.path.split('/').some(part => part.startsWith('.')) || (!extensions.has(extname(entry.path)) && entry.path !== 'web/assets/license-dm-sans.txt')) throw new Error(`DAPP_NONPUBLIC_WEB_FILE_REFUSED: ${entry.path}`);
    mkdirSync(dirname(join(stage, entry.path)), { recursive: true });
    writeFileSync(join(stage, entry.path), execFileSync('git', ['cat-file', 'blob', entry.object], { cwd: root, maxBuffer: 1 << 26 }));
    chmodSync(join(stage, entry.path), 0o644);
  }
}

export function validateStaticTree(root) {
  const files = walk(root).filter(file => file.startsWith('web/') || file.startsWith('dist/browser/'));
  const present = new Set(files);
  const target = (file, specifier) => {
    if (!specifier.startsWith('.')) throw new Error(`DAPP_NONLOCAL_IMPORT: ${file} -> ${specifier}`);
    const resolved = relative(root, resolve(root, dirname(file), specifier)).split('\\').join('/');
    if (!present.has(resolved)) throw new Error(`DAPP_UNRESOLVED_IMPORT: ${file} -> ${specifier}`);
  };
  let relativeImports = 0;
  for (const file of files.filter(file => /\.(js|mjs)$/.test(file))) {
    const source = readFileSync(join(root, file), 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (parsed.parseDiagnostics.length) throw new Error(`DAPP_MODULE_SYNTAX_REFUSED: ${file}`);
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error('DAPP_IMPORT_LITERAL_REQUIRED');
        target(file, node.moduleSpecifier.text); relativeImports++;
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new Error('DAPP_DYNAMIC_IMPORT_REFUSED');
        target(file, node.arguments[0].text); relativeImports++;
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  const pageFile = 'web/index.html';
  if (!present.has(pageFile)) throw new Error('DAPP_PAGE_MISSING');
  const page = readFileSync(join(root, pageFile), 'utf8');
  let pageAssets = 0;
  for (const match of page.matchAll(/<(?:script|link|img|source|video|audio|iframe)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)) {
    const reference = match[1];
    if (/^(?:[a-z]+:|\/)/i.test(reference)) throw new Error(`DAPP_EXTERNAL_ASSET_REFUSED: ${reference}`);
    target(pageFile, `./${reference}`); pageAssets++;
  }
  if (!/<meta http-equiv="Content-Security-Policy"/.test(page)) throw new Error('DAPP_PAGE_CSP_MISSING');
  if (!present.has('web/release-config.json') || !present.has('web/release-profile.mjs')) throw new Error('DAPP_RELEASE_PROFILE_MISSING');
  const negation = String.raw`(?:not|never|no|without|refuses? to be|yet to be|pending)\s+(?:\w+\s+){0,2}`;
  const claims = ['independently audited', 'security[- ]approved', 'production[- ]ready', 'release[- ]accepted', 'audit(?:ed)? complete'];
  for (const file of files.filter(file => /\.(mjs|js|html|css)$/.test(file))) {
    const content = readFileSync(join(root, file), 'utf8');
    if (claims.some(claim => new RegExp(String.raw`(?<!${negation})(?:${claim})`, 'i').test(content))) throw new Error(`DAPP_FORBIDDEN_CLAIM: ${file}`);
  }
  return { files, relativeImports, pageAssets };
}
