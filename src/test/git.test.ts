import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseWorktrees } from '../git';

test('parseWorktrees: main checkout, branch worktrees and a detached one', () => {
  const porcelain = [
    'worktree D:/SourceCode/Repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree D:/SourceCode/Repo/.worktrees/upgrade thing',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/feat/upgrade-thing',
    '',
    'worktree D:/SourceCode/Repo/.worktrees/detached',
    'HEAD 3333333333333333333333333333333333333333',
    'detached',
    '',
  ].join('\r\n');
  assert.deepEqual(parseWorktrees(porcelain), [
    { path: 'D:/SourceCode/Repo', branch: 'main' },
    { path: 'D:/SourceCode/Repo/.worktrees/upgrade thing', branch: 'feat/upgrade-thing' },
    { path: 'D:/SourceCode/Repo/.worktrees/detached' },
  ]);
});
