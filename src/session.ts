import * as path from 'path';
import { FileDiff, parseUnifiedDiff } from './diff';
import * as git from './git';

function pathKey(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

async function changedFiles(root: string, fromCommit: string): Promise<FileDiff[]> {
  const files = parseUnifiedDiff(await git.diffAgainst(root, fromCommit));
  for (const rel of await git.untrackedFiles(root)) {
    files.push({ oldPath: null, newPath: rel, status: 'added', binary: false, hunks: [] });
  }
  return files;
}

/**
 * The set of changes being reviewed: everything between a starting commit and the working tree.
 *
 * The right-hand side is always the files on disk, because that is what the language server
 * reads and what the editor shows.
 */
export class PrSession {
  private readonly byHeadPath = new Map<string, FileDiff>();

  constructor(
    readonly root: string,
    /** Name to show for the left-hand side: a branch, or a short commit id. */
    readonly baseRef: string,
    /** The commit the diff starts from. */
    readonly mergeBase: string,
    readonly label: string,
    readonly files: FileDiff[],
    /** True when the start is a fixed commit rather than the merge-base with a branch. */
    readonly fixedStart = false,
  ) {
    for (const f of files) {
      if (f.newPath) {
        this.byHeadPath.set(pathKey(path.resolve(root, f.newPath)), f);
      }
    }
  }

  /** Review a branch: from where it left `baseRef` to the working tree. */
  static async load(root: string, baseRef: string, label?: string): Promise<PrSession> {
    const base = await git.mergeBase(root, baseRef);
    return new PrSession(path.normalize(root), baseRef, base, label ?? `vs ${baseRef}`, await changedFiles(root, base));
  }

  /**
   * Review one commit that is checked out here: from its parent to the working tree.
   * A merge commit is compared with its first parent, the branch it was merged into,
   * so what shows up is what the merge brought in.
   */
  static async loadCommit(root: string, rev = 'HEAD'): Promise<PrSession> {
    const commit = await git.commitInfo(root, rev);
    const parent = commit.parents[0];
    const start = parent ?? git.EMPTY_TREE;
    const subject = commit.subject.length > 48 ? commit.subject.slice(0, 47) + '…' : commit.subject;
    return new PrSession(
      path.normalize(root),
      parent ? parent.slice(0, 7) : 'nothing',
      start,
      `commit ${commit.short} ${subject}`,
      await changedFiles(root, start),
      true,
    );
  }

  async reload(): Promise<PrSession> {
    if (this.fixedStart) {
      return new PrSession(this.root, this.baseRef, this.mergeBase, this.label, await changedFiles(this.root, this.mergeBase), true);
    }
    return PrSession.load(this.root, this.baseRef, this.label);
  }

  /** Diff for a file on disk, if the PR touches it. */
  fileForPath(fsPath: string): FileDiff | undefined {
    return this.byHeadPath.get(pathKey(fsPath));
  }

  headPath(file: FileDiff): string | undefined {
    return file.newPath ? path.resolve(this.root, file.newPath) : undefined;
  }

  contains(fsPath: string): boolean {
    const rel = path.relative(this.root, fsPath);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  relative(fsPath: string): string {
    return path.relative(this.root, fsPath).replace(/\\/g, '/');
  }
}
