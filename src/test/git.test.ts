import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseCommits, parseWorktrees } from '../git';

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
    { path: 'D:/SourceCode/Repo', head: '1'.repeat(40), branch: 'main' },
    { path: 'D:/SourceCode/Repo/.worktrees/upgrade thing', head: '2'.repeat(40), branch: 'feat/upgrade-thing' },
    { path: 'D:/SourceCode/Repo/.worktrees/detached', head: '3'.repeat(40) },
  ]);
});

test('parseCommits: a merge, an ordinary commit and a root commit', () => {
  const f = '\x1f';
  const out = [
    ['aaa1', 'aaa', 'Merge pull request #1 from x/y', 'Dion', '2 hours ago', 'bbb1 ccc1'].join(f),
    ['bbb1', 'bbb', 'Fix: a | b, with "quotes"', 'Someone Else', '3 days ago', 'ddd1'].join(f),
    ['ddd1', 'ddd', 'Initial commit', 'Dion', '4 weeks ago', ''].join(f),
    '',
  ].join('\n');
  const [merge, plain, rootCommit] = parseCommits(out);
  assert.deepEqual(merge.parents, ['bbb1', 'ccc1']);
  assert.equal(merge.subject, 'Merge pull request #1 from x/y');
  assert.deepEqual([plain.sha, plain.short, plain.subject, plain.author, plain.when], ['bbb1', 'bbb', 'Fix: a | b, with "quotes"', 'Someone Else', '3 days ago']);
  assert.deepEqual(rootCommit.parents, []);
});
