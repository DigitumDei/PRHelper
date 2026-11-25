import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as git from '../git';
import { worktreePathFor } from '../worktree';

const none = () => false;
const main = path.resolve(os.tmpdir(), 'Repo');
const wt = (...parts: string[]) => ({ path: path.join(main, ...parts), branch: 'x' });

test('worktreePathFor: no worktrees yet uses the configured folder and the branch leaf', () => {
  assert.equal(
    worktreePathFor([{ path: main, branch: 'main' }], '.worktrees', 'feat/upgrade-thing-0.2.23', 234, none),
    path.join(main, '.worktrees', 'upgrade-thing-0.2.23'),
  );
});

test('worktreePathFor: goes beside most of the existing worktrees, wherever they are', () => {
  const outside = path.resolve(os.tmpdir(), 'elsewhere');
  const trees = [
    { path: main, branch: 'main' },
    { path: path.join(outside, 'one-off'), branch: 'a' },
    wt('trees', 'b'),
    wt('trees', 'c'),
  ];
  assert.equal(worktreePathFor(trees, '.worktrees', 'fix/login', 7, none), path.join(main, 'trees', 'login'));
});

test('worktreePathFor: accepts the forward-slash paths git prints on Windows', () => {
  const trees = [{ path: main.replace(/\\/g, '/'), branch: 'main' }];
  assert.equal(worktreePathFor(trees, '.worktrees', 'topic', 1, none), path.join(main, '.worktrees', 'topic'));
});

test('worktreePathFor: name collisions and unusable branch names', () => {
  const trees = [{ path: main, branch: 'main' }];
  const taken = path.join(main, '.worktrees', 'login');
  assert.equal(
    worktreePathFor(trees, '.worktrees', 'fix/login', 7, (p) => p === taken),
    path.join(main, '.worktrees', 'login-pr7'),
  );
  assert.equal(worktreePathFor(trees, '.worktrees', 'user:weird name!', 9, none), path.join(main, '.worktrees', 'user-weird-name'));
  assert.equal(worktreePathFor(trees, '.worktrees', '///', 9, none), path.join(main, '.worktrees', 'pr-9'));
  assert.throws(() => worktreePathFor(trees, '.worktrees', 'fix/login', 7, () => true), /already exist/);
});

test('git: create a detached worktree, see it listed, and remove it again', async () => {
  const repo = path.resolve(__dirname, '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prflow-wt-'));
  try {
    execFileSync(process.execPath, [path.join(repo, 'dev', 'make-fixture.js'), dir], { stdio: 'pipe' });
    const before = await git.listWorktrees(dir);
    assert.equal(before.length, 1);
    assert.equal(before[0].branch, 'feature');

    const dest = worktreePathFor(before, '.worktrees', 'feat/some-pr', 12, fs.existsSync);
    assert.equal(await git.isIgnored(dir, dest), false);
    await git.addDetachedWorktree(dir, dest);
    assert.ok(fs.existsSync(path.join(dest, 'src', 'orders.ts')));
    const during = await git.listWorktrees(dir);
    assert.equal(during.length, 2);
    assert.equal(during[1].branch, undefined); // detached until `gh pr checkout` runs inside it
    // The new folder must not leak into the main checkout's list of changed files.
    assert.deepEqual(await git.untrackedFiles(dir), []);

    await git.removeWorktree(dir, dest);
    assert.equal(fs.existsSync(dest), false);
    assert.equal((await git.listWorktrees(dir)).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
