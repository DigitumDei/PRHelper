/**
 * Turns diff hunks into answers about a function and its calls:
 * is this function new or modified, is this call new, which calls went away.
 * Pure: no vscode imports. Line numbers are 1-based and inclusive.
 */
import { FileDiff, Hunk } from './diff';

/** How a function relates to the PR. */
export type NodeChange = 'new' | 'modified' | 'unchanged';
/** How a call (an edge in the flow) relates to the PR. */
export type EdgeChange = 'new' | 'modified' | 'removed' | 'unchanged';

export interface RangeStats {
  change: NodeChange;
  added: number;
  removed: number;
}

export function isLineAdded(file: FileDiff, line: number): boolean {
  return file.hunks.some((h) => h.newCount > 0 && line >= h.newStart && line < h.newStart + h.newCount);
}

/** Hunks that land inside [start, end] on the head side. */
export function hunksTouching(file: FileDiff, start: number, end: number): Hunk[] {
  return file.hunks.filter((h) =>
    h.newCount > 0
      ? h.newStart <= end && h.newStart + h.newCount - 1 >= start
      : // A pure deletion sits between newStart and newStart + 1; both must be inside.
        h.newStart >= start && h.newStart < end,
  );
}

export function classifyRange(file: FileDiff | undefined, start: number, end: number): RangeStats {
  if (!file) {
    return { change: 'unchanged', added: 0, removed: 0 };
  }
  let added = 0;
  let removed = 0;
  for (const h of hunksTouching(file, start, end)) {
    if (h.newCount > 0) {
      const s = Math.max(start, h.newStart);
      const e = Math.min(end, h.newStart + h.newCount - 1);
      added += e - s + 1;
    }
    removed += h.removed.length;
  }
  const length = end - start + 1;
  if (file.status === 'added' || added === length) {
    return { change: 'new', added, removed };
  }
  return { change: added > 0 || removed > 0 ? 'modified' : 'unchanged', added, removed };
}

const GENERIC_ARGS = '(?:(?:::)?<[^<>()]*>)?';
const CALL_RE = new RegExp(`([A-Za-z_$][\\w$]*)\\s*${GENERIC_ARGS}\\s*\\(`, 'g');

/** Words that can sit in front of `(` without being a call worth showing. */
const NOT_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'match', 'return', 'catch', 'when', 'await', 'typeof', 'sizeof',
  'new', 'in', 'of', 'loop', 'else', 'do', 'try', 'throw', 'yield', 'assert', 'super', 'this', 'self',
  'fn', 'function', 'fun', 'def', 'func', 'constructor', 'let', 'const', 'var', 'use', 'import',
  'export', 'async', 'move', 'where', 'impl', 'pub', 'static', 'class', 'struct', 'enum', 'trait',
  'interface', 'type', 'as', 'is', 'not', 'and', 'or', 'with', 'elif', 'lambda', 'delete', 'void',
  'using', 'lock', 'foreach', 'until', 'unless', 'synchronized', 'Some', 'Ok', 'Err', 'None',
]);

const DECLARATION_BEFORE = /\b(?:fn|function|fun|def|func)\s+$/;
const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*)/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Reduce a call hierarchy item name such as `Foo::bar<T>(x)` or `obj.method` to `bar` / `method`. */
export function bareName(name: string): string {
  const head = name.split(/[(<]/, 1)[0].trim();
  const parts = head.split(/::|\.|#|\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : head;
}

export function isCalledIn(text: string, name: string): boolean {
  const re = new RegExp(`(?:^|[^\\w$])${escapeRegExp(name)}\\s*${GENERIC_ARGS}\\s*\\(`);
  return re.test(text);
}

/**
 * Classify one call out of a function.
 * @param file diff of the file holding the call sites (the caller's file)
 * @param callSiteLines 1-based lines where the call happens
 * @param calleeName name of the function being called
 * @param removedText lines the PR removed from the calling function
 */
export function classifyCallEdge(
  file: FileDiff | undefined,
  callSiteLines: number[],
  calleeName: string,
  removedText: string[],
): EdgeChange {
  if (!file || callSiteLines.length === 0) {
    return 'unchanged';
  }
  if (file.status === 'added') {
    return 'new';
  }
  const onAdded = callSiteLines.filter((l) => isLineAdded(file, l)).length;
  if (onAdded === 0) {
    return 'unchanged';
  }
  if (onAdded < callSiteLines.length) {
    return 'modified';
  }
  // Every call site is on an added line. If the old code called it too, the call was edited or moved.
  const name = bareName(calleeName);
  return removedText.some((line) => isCalledIn(line, name)) ? 'modified' : 'new';
}

/**
 * Calls that appear in removed lines and no longer appear in the function.
 * A text heuristic: it reads the removed lines, it does not resolve symbols.
 */
export function findRemovedCalls(removedText: string[], currentBody: string, knownCallees: string[]): string[] {
  const known = new Set(knownCallees);
  const found: string[] = [];
  for (const line of removedText) {
    if (COMMENT_LINE.test(line)) {
      continue;
    }
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(line)) !== null) {
      const name = m[1];
      if (NOT_CALLS.has(name) || known.has(name) || found.includes(name)) {
        continue;
      }
      if (DECLARATION_BEFORE.test(line.slice(0, m.index))) {
        continue;
      }
      if (isCalledIn(currentBody, name)) {
        continue;
      }
      found.push(name);
    }
  }
  return found;
}
