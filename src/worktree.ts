import * as path from 'path';
import { Worktree } from './git';

/**
 * Decide where a new worktree should go.
 *
 * Follows what the repo already does: if it has other worktrees, the new one goes beside
 * most of them. Otherwise it goes in `configured` (relative to the main checkout).
 * The folder is named after the last segment of `name` (a branch such as `feat/login`, or a
 * plain name such as `commit-1a2b3c4`).
 *
 * @param worktrees output of `git worktree list`; the first entry is the main checkout
 * @param fallback used as the folder name when `name` has no usable characters, and added to
 *   the name when that folder already exists (for example `pr-234`)
 */
export function worktreePathFor(
  worktrees: Worktree[],
  configured: string,
  name: string,
  fallback: string,
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

  const leaf = name.split('/').filter(Boolean).pop() ?? '';
  const folder = leaf.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || fallback;
  for (const candidate of [path.join(parent, folder), path.join(parent, `${folder}-${fallback}`)]) {
    if (!exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Both ${path.join(parent, folder)} and its "-${fallback}" variant already exist.`);
}
