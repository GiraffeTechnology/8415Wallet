import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { TASK_RECEIPT_RUNTIME_FILES, createTaskReceiptAdapter } from '../server/task-receipt-adapter.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
function imports(path) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) || statement.isTypeOnly) return [];
    const clause = statement.importClause;
    if (clause?.isTypeOnly || clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name &&
      clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly)) return [];
    return [statement.moduleSpecifier.text];
  });
}
function closure(entry) {
  const paths = new Set(), visit = path => {
    if (paths.has(path)) return; paths.add(path);
    for (const dependency of imports(path)) {
      if (dependency.startsWith('node:')) continue;
      assert.ok(dependency.startsWith('.'), `unexpected external runtime dependency: ${dependency}`);
      visit(resolve(dirname(path), dependency));
    }
  }; visit(resolve(root, entry)); return [...paths].map(path => relative(root, path)).sort();
}
test('declared receipt runtime closure equals the actual non-type import graph exactly', () => {
  assert.deepEqual([...TASK_RECEIPT_RUNTIME_FILES].sort(), closure('server/task-receipt-adapter.mjs'));
  assert.equal(TASK_RECEIPT_RUNTIME_FILES.length, new Set(TASK_RECEIPT_RUNTIME_FILES).size);
});
test('exact native-TS runtime closure loads alone, missing dependencies refuse, source changes change identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'receipt-runtime-'));
  try {
    for (const path of TASK_RECEIPT_RUNTIME_FILES) { const destination = join(directory, path); mkdirSync(dirname(destination), { recursive: true }); cpSync(join(root, path), destination); }
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    const program = "import {createTaskReceiptAdapter} from './server/task-receipt-adapter.mjs'; console.log(createTaskReceiptAdapter({provider:{async request(){}},observationPolicy:{minimumConfirmations:'2'}}).identity.verifierImplementationDigest)";
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', program], { cwd: directory, encoding: 'utf8' });
    const original = run(); assert.equal(original.status, 0, original.stderr);
    const expected = createTaskReceiptAdapter({ provider: { async request() {} }, observationPolicy: { minimumConfirmations: '2' } }).identity.verifierImplementationDigest;
    assert.equal(original.stdout.trim(), expected);
    const path = join(directory, 'src/codec/keccak.ts'); writeFileSync(path, readFileSync(path, 'utf8') + '\n// Changed fixture bytes.\n');
    const changed = run(); assert.equal(changed.status, 0, changed.stderr); assert.notEqual(changed.stdout.trim(), expected);
    rmSync(join(directory, 'src/sdk/errors.ts')); const missing = run(); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
