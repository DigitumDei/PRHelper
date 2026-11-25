import { execFile } from 'child_process';

export class CommandError extends Error {}

export function run(cmd: string, args: string[], cwd: string, timeoutMs = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: 512 * 1024 * 1024, windowsHide: true, encoding: 'utf8', timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message).trim();
          reject(new CommandError(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${detail}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

const git = (cwd: string, ...args: string[]) => run('git', args, cwd);

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, 'rev-parse', '--show-toplevel')).trim();
}

export async function currentBranch(root: string): Promise<string> {
  return (await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
}

export async function refExists(root: string, ref: string): Promise<boolean> {
  try {
    await git(root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** Best guess at the branch a PR from here would target. */
export async function defaultBase(root: string): Promise<string | undefined> {
  try {
    const head = (await git(root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')).trim();
    if (head) {
      return head;
    }
  } catch {
    // origin/HEAD is not always set; fall through to the usual names.
  }
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await refExists(root, ref)) {
      return ref;
    }
  }
  return undefined;
}

export async function mergeBase(root: string, base: string): Promise<string> {
  return (await git(root, 'merge-base', base, 'HEAD')).trim();
}

/** Diff from a commit to the working tree, so line numbers match the files on disk. */
export function diffAgainst(root: string, commit: string): Promise<string> {
  return git(root, '-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '-M', '--unified=0', commit, '--');
}

/** What a commit with no parent is compared against. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  /** Relative date, e.g. "2 hours ago". */
  when: string;
  /** More than one for a merge; the first is the branch that was merged into. */
  parents: string[];
}

const COMMIT_FORMAT = ['%H', '%h', '%s', '%an', '%ar', '%P'].join('%x1f');

export function parseCommits(out: string): Commit[] {
  return out
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      const [sha, short, subject, author, when, parents] = line.split('\x1f');
      return { sha, short, subject, author, when, parents: (parents ?? '').split(' ').filter(Boolean) };
    });
}

export async function recentCommits(root: string, count = 100): Promise<Commit[]> {
  return parseCommits(await git(root, 'log', '-n', String(count), `--format=${COMMIT_FORMAT}`));
}

export async function commitInfo(root: string, rev: string): Promise<Commit> {
  const [commit] = parseCommits(await git(root, 'log', '-1', `--format=${COMMIT_FORMAT}`, rev));
  if (!commit) {
    throw new CommandError(`No commit found for ${rev}.`);
  }
  return commit;
}

/** New files not yet added to git; `git diff` does not report these. */
export async function untrackedFiles(root: string): Promise<string[]> {
  const out = await git(root, '-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard');
  return out
    .split('\n')
    .map((s) => s.trim())
    // A trailing slash is a nested checkout (such as a worktree folder), not a file.
    .filter((s) => s && !s.endsWith('/'));
}

export function showFile(root: string, commit: string, relPath: string): Promise<string> {
  return git(root, 'show', `${commit}:${relPath}`);
}

export async function listRefs(root: string): Promise<string[]> {
  const out = await git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes');
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith('/HEAD'));
}

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  author?: { login?: string };
}

export async function listPullRequests(root: string): Promise<PullRequest[]> {
  const out = await run(
    'gh',
    ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,headRefName,baseRefName,isDraft,author'],
    root,
  );
  return JSON.parse(out) as PullRequest[];
}

/** The open pull request for the branch checked out in `root`, if there is one. Never throws. */
export async function pullRequestForCurrentBranch(root: string): Promise<PullRequest | undefined> {
  try {
    const out = await run(
      'gh',
      ['pr', 'view', '--json', 'number,title,headRefName,baseRefName,isDraft,state'],
      root,
      8000,
    );
    const pr = JSON.parse(out) as PullRequest & { state?: string };
    return pr.state === 'OPEN' ? pr : undefined;
  } catch {
    return undefined; // no PR for this branch, gh missing, offline, or not a GitHub repo
  }
}

export interface Worktree {
  path: string;
  /** The commit checked out there. */
  head?: string;
  /** Short branch name; undefined for a detached HEAD. */
  branch?: string;
}

export function parseWorktrees(porcelain: string): Worktree[] {
  const trees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const raw of porcelain.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
      trees.push(current);
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return trees;
}

export async function listWorktrees(root: string): Promise<Worktree[]> {
  return parseWorktrees(await git(root, 'worktree', 'list', '--porcelain'));
}

/** A new worktree on no branch, at `commit` or at the current commit. */
export async function addDetachedWorktree(root: string, dir: string, commit?: string): Promise<void> {
  await git(root, 'worktree', 'add', '--detach', dir, ...(commit ? [commit] : []));
}

export async function removeWorktree(root: string, dir: string): Promise<void> {
  await git(root, 'worktree', 'remove', '--force', dir);
}

export async function isIgnored(root: string, target: string): Promise<boolean> {
  try {
    await git(root, 'check-ignore', '-q', target);
    return true;
  } catch {
    return false;
  }
}

export async function checkoutPullRequest(root: string, number: number): Promise<void> {
  await run('gh', ['pr', 'checkout', String(number)], root);
}
