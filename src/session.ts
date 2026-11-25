import * as path from 'path';
import { FileDiff, parseUnifiedDiff } from './diff';
import * as git from './git';

function pathKey(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** The set of changes being reviewed: everything between a base ref and the working tree. */
export class PrSession {
  private readonly byHeadPath = new Map<string, FileDiff>();

  constructor(
    readonly root: string,
    readonly baseRef: string,
    readonly mergeBase: string,
    readonly label: string,
    readonly files: FileDiff[],
  ) {
    for (const f of files) {
      if (f.newPath) {
        this.byHeadPath.set(pathKey(path.resolve(root, f.newPath)), f);
      }
    }
  }

  static async load(root: string, baseRef: string, label?: string): Promise<PrSession> {
    const base = await git.mergeBase(root, baseRef);
    const files = parseUnifiedDiff(await git.diffAgainst(root, base));
    for (const rel of await git.untrackedFiles(root)) {
      files.push({ oldPath: null, newPath: rel, status: 'added', binary: false, hunks: [] });
    }
    return new PrSession(path.normalize(root), baseRef, base, label ?? `vs ${baseRef}`, files);
  }

  reload(): Promise<PrSession> {
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
