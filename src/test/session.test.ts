import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyCallEdge, classifyRange, findRemovedCalls, hunksTouching } from '../classify';
import { PrSession } from '../session';

// Real git, real repo: builds the fixture from dev/make-fixture.js in a temp folder.
const repo = path.resolve(__dirname, '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prflow-fixture-'));
execFileSync(process.execPath, [path.join(repo, 'dev', 'make-fixture.js'), dir], { stdio: 'pipe' });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('session: loads the diff between the base branch and the working tree', async () => {
  const session = await PrSession.load(dir, 'main');
  assert.deepEqual(
    session.files.map((f) => `${f.status} ${f.newPath}`),
    ['modified src/api.ts', 'added src/inventory.ts', 'modified src/orders.ts'],
  );
  assert.equal(session.fileForPath(path.join(dir, 'src', 'billing.ts')), undefined);
  assert.equal(session.relative(path.join(dir, 'src', 'orders.ts')), 'src/orders.ts');
});

test('session: classifies submitOrder and its calls from real git output', async () => {
  const session = await PrSession.load(dir, 'main');
  const orders = session.fileForPath(path.join(dir, 'src', 'orders.ts'));
  assert.ok(orders);
  // submitOrder spans lines 7..13 of the head file.
  assert.deepEqual(classifyRange(orders, 7, 13), { change: 'modified', added: 4, removed: 3 });
  const removed = hunksTouching(orders, 7, 13).flatMap((h) => h.removed);
  assert.equal(classifyCallEdge(orders, [8], 'reserveStock', removed), 'new');
  assert.equal(classifyCallEdge(orders, [9], 'chargeCard', removed), 'modified');
  assert.equal(classifyCallEdge(orders, [10], 'audit', removed), 'unchanged');
  assert.equal(classifyCallEdge(orders, [11], 'publish', removed), 'new');
  const body = fs.readFileSync(path.join(dir, 'src', 'orders.ts'), 'utf8').split('\n').slice(6, 13).join('\n');
  assert.deepEqual(findRemovedCalls(removed, body, []), ['sendReceipt']);

  const api = session.fileForPath(path.join(dir, 'src', 'api.ts'));
  assert.equal(classifyRange(api, 4, 6).change, 'unchanged'); // createOrderHandler
  assert.equal(classifyRange(api, 8, 11).change, 'new'); // checkoutV2
});

test('session: uncommitted edits and untracked files are part of the comparison', async () => {
  fs.writeFileSync(path.join(dir, 'src', 'scratch.ts'), 'export function scratch() {\n  return 1;\n}\n');
  fs.appendFileSync(path.join(dir, 'src', 'billing.ts'), '\nexport function refund() {\n  return 0;\n}\n');
  const session = await PrSession.load(dir, 'main');
  const scratch = session.fileForPath(path.join(dir, 'src', 'scratch.ts'));
  assert.equal(scratch?.status, 'added');
  assert.equal(classifyRange(scratch, 1, 3).change, 'new');
  const billing = session.fileForPath(path.join(dir, 'src', 'billing.ts'));
  assert.equal(classifyRange(billing, 1, 3).change, 'unchanged'); // chargeCard
  assert.equal(classifyRange(billing, 5, 7).change, 'new'); // refund
});
