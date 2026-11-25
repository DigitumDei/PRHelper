/**
 * Parsing of `git diff --unified=0` output. Pure: no vscode or git imports,
 * so it can be unit tested with plain node.
 *
 * Line numbers are 1-based throughout, matching git.
 */

export interface Hunk {
  oldStart: number;
  oldCount: number;
  /** For a pure deletion (newCount === 0) this is the head line the deletion sits after. */
  newStart: number;
  newCount: number;
  removed: string[];
  added: string[];
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface FileDiff {
  /** Path on the base side, relative to the repo root. Null for added files. */
  oldPath: string | null;
  /** Path on the head side, relative to the repo root. Null for deleted files. */
  newPath: string | null;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquote(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    return p
      .slice(1, -1)
      .replace(/\\(["\\tn])/g, (_m, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c));
  }
  return p;
}

function stripPrefix(p: string, prefix: 'a/' | 'b/'): string | null {
  const clean = unquote(p.replace(/\t.*$/, ''));
  if (clean === '/dev/null') {
    return null;
  }
  return clean.startsWith(prefix) ? clean.slice(prefix.length) : clean;
}

/** `diff --git a/P b/P` where both sides are the same path (the only case with no other header to read). */
function pathsFromGitLine(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice('diff --git '.length);
  const len = (rest.length - 5) / 2;
  if (Number.isInteger(len) && len > 0) {
    const a = rest.slice(2, 2 + len);
    const b = rest.slice(2 + len + 3);
    if (rest.startsWith('a/') && rest.slice(2 + len, 2 + len + 3) === ' b/' && a === b) {
      return { oldPath: a, newPath: b };
    }
  }
  return null;
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = text.split('\n');
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;

  for (let raw of lines) {
    if (raw.endsWith('\r')) {
      raw = raw.slice(0, -1);
    }

    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const tag = raw[0];
      if (tag === '+' && newLeft > 0) {
        hunk.added.push(raw.slice(1));
        newLeft--;
        continue;
      }
      if (tag === '-' && oldLeft > 0) {
        hunk.removed.push(raw.slice(1));
        oldLeft--;
        continue;
      }
      if (tag === ' ') {
        oldLeft--;
        newLeft--;
        continue;
      }
      if (tag === '\\') {
        continue;
      }
      // Anything else means the counts lied; fall through and treat as a header.
      oldLeft = 0;
      newLeft = 0;
    }

    if (raw.startsWith('diff --git ')) {
      const guess = pathsFromGitLine(raw);
      file = {
        oldPath: guess?.oldPath ?? null,
        newPath: guess?.newPath ?? null,
        status: 'modified',
        binary: false,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) {
      continue;
    }

    if (raw.startsWith('new file mode')) {
      file.status = 'added';
      file.oldPath = null;
    } else if (raw.startsWith('deleted file mode')) {
      file.status = 'deleted';
      file.newPath = null;
    } else if (raw.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = unquote(raw.slice('rename from '.length));
    } else if (raw.startsWith('rename to ')) {
      file.status = 'renamed';
      file.newPath = unquote(raw.slice('rename to '.length));
    } else if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      file.binary = true;
    } else if (raw.startsWith('--- ')) {
      file.oldPath = stripPrefix(raw.slice(4), 'a/');
    } else if (raw.startsWith('+++ ')) {
      file.newPath = stripPrefix(raw.slice(4), 'b/');
    } else {
      const m = HUNK_HEADER.exec(raw);
      if (m) {
        hunk = {
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
          removed: [],
          added: [],
        };
        oldLeft = hunk.oldCount;
        newLeft = hunk.newCount;
        file.hunks.push(hunk);
      }
    }
  }
  return files;
}
