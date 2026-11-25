import * as path from 'path';
import { Worktree } from './git';

/**
 * Decide where a new worktree for a pull request should go.
 *
 * Follows what the repo already does: if it has other worktrees, the new one goes beside
 * most of them. Otherwise it goes in `configured` (relative to the main checkout).
 * The folder is named after the last segment of the PR's branch.
 *
 * @param worktrees output of `git worktree list`; the first entry is the main checkout
 */
export function worktreePathFor(
  worktrees: Worktree[],
  configured: string,
  headRefName: string,
  prNumber: number,
  exists: (p: string) => boolean,
): string {
  if (worktrees.length === 0) {
    throw new Error('git reported no worktrees for this repository.');
  }
  const main = path.normalize(worktrees[0].path);

  const counts = new Map<string, number>();
  for (const w of worktrees.slice(1)) {
    const parent = path.dirname(path.normalize(w.path));
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let parent = path.resolve(main, configured || '.worktrees');
  let best = 0;
  for (const [dir, n] of counts) {
    if (n > best) {
      best = n;
      parent = dir;
    }
  }

  const leaf = headRefName.split('/').filter(Boolean).pop() ?? '';
  const name = leaf.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || `pr-${prNumber}`;
  for (const candidate of [path.join(parent, name), path.join(parent, `${name}-pr${prNumber}`)]) {
    if (!exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Both ${path.join(parent, name)} and its "-pr${prNumber}" variant already exist.`);
}
