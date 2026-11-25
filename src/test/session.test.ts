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

test('session: the latest commit, a merge commit and a root commit', async () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'prflow-commit-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: own, stdio: 'pipe' })
      .toString()
      .trim();
  try {
    execFileSync(process.execPath, [path.join(repo, 'dev', 'make-fixture.js'), own], { stdio: 'pipe' });
    const expected = ['modified src/api.ts', 'added src/inventory.ts', 'modified src/orders.ts'];
    const list = (s: PrSession) => s.files.map((f) => `${f.status} ${f.newPath}`);

    // On the feature branch, the latest commit is the feature commit.
    const feature = await PrSession.loadCommit(own);
    assert.deepEqual(list(feature), expected);
    assert.match(feature.label, /^commit [0-9a-f]{7,} feature: reserve stock/);
    assert.equal(feature.fixedStart, true);

    // Merge it into main the way a pull request does. This is "sitting on main after a merge":
    // nothing differs from the default branch, but the merge commit brought the feature in.
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'Merge pull request #1 from fixture/feature', 'feature');
    assert.deepEqual(list(await PrSession.load(own, 'main')), []);
    const merge = await PrSession.loadCommit(own);
    assert.deepEqual(list(merge), expected);
    assert.match(merge.label, /^commit [0-9a-f]{7,} Merge pull request #1/);
    assert.equal(merge.mergeBase, git('rev-parse', 'HEAD^1'));
    // Same classification as reviewing the branch did.
    const orders = merge.fileForPath(path.join(own, 'src', 'orders.ts'));
    assert.deepEqual(classifyRange(orders, 7, 13), { change: 'modified', added: 4, removed: 3 });

    // Reloading keeps the same starting commit and picks up new edits on disk.
    fs.appendFileSync(path.join(own, 'src', 'billing.ts'), '\nexport const extra = 1;\n');
    const reloaded = await merge.reload();
    assert.equal(reloaded.mergeBase, merge.mergeBase);
    assert.deepEqual(list(reloaded), ['modified src/api.ts', 'modified src/billing.ts', 'added src/inventory.ts', 'modified src/orders.ts']);
    git('checkout', '-q', '--', 'src/billing.ts');

    // The very first commit has no parent: everything in it is new.
    git('checkout', '-q', '--detach', git('rev-list', '--max-parents=0', 'HEAD'));
    const first = await PrSession.loadCommit(own);
    assert.equal(first.baseRef, 'nothing');
    assert.ok(first.files.length >= 7);
    assert.ok(first.files.every((f) => f.status === 'added'));
  } finally {
    fs.rmSync(own, { recursive: true, force: true });
  }
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
