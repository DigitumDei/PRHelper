import * as path from 'path';
import * as vscode from 'vscode';
import {
  EdgeChange,
  NodeChange,
  bareName,
  classifyCallEdge,
  classifyRange,
  findRemovedCalls,
  hunksTouching,
} from './classify';
import { FileDiff } from './diff';
import { PrSession } from './session';
import { Callable } from './symbols';

/** A call site the panel can jump to. */
export interface SiteVM {
  id: string;
  line: number;
}

/** One caller or callee, as the panel draws it. */
export interface NodeVM {
  id: string;
  name: string;
  where: string;
  /** How the call between this node and the focus changed. */
  edge: EdgeChange;
  /** Whether this function is itself touched by the PR. */
  node: NodeChange;
  external: boolean;
  clickable: boolean;
  sites: SiteVM[];
}

export interface FocusVM {
  name: string;
  where: string;
  change: NodeChange;
  added: number;
  removed: number;
  /** Set when the function calls itself: drawn as a loop on the centre card. */
  recursion?: { edge: EdgeChange; sites: SiteVM[] };
}

export interface FlowVM {
  focus: FocusVM;
  callers: NodeVM[];
  callees: NodeVM[];
  hiddenCallers: number;
  hiddenCallees: number;
  note?: string;
}

/** Where a click in the panel should take the editor, and which function to centre on next. */
export interface NavTarget {
  uri: vscode.Uri;
  reveal: vscode.Range;
  focusAt?: vscode.Position;
  /**
   * The function to centre on, taken straight from the call hierarchy. Without it the function
   * has to be found again in the file's symbol list, which leaves out things the call hierarchy
   * does know about, such as one-line arrow functions and closures.
   */
  callable?: Callable;
}

function callableOf(item: vscode.CallHierarchyItem): Callable {
  return {
    name: item.name,
    container: '',
    kind: item.kind,
    // For `const f = () => ...` TypeScript reports the arrow function as the range and `f` as the
    // name, so the name can sit outside the range. Join them so the function owns its own name.
    range: item.range.union(item.selectionRange),
    selectionRange: item.selectionRange,
    strict: true,
  };
}

export interface FlowResult {
  vm: FlowVM;
  targets: Map<string, NavTarget>;
}

const EXTERNAL_DIR = /[\\/](?:node_modules|\.cargo|\.rustup|\.gradle)[\\/]/;
const CALLABLE_KINDS = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

function isExternal(uri: vscode.Uri): boolean {
  return uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri) || EXTERNAL_DIR.test(uri.fsPath);
}

function fileOf(session: PrSession | undefined, uri: vscode.Uri): FileDiff | undefined {
  return session && uri.scheme === 'file' ? session.fileForPath(uri.fsPath) : undefined;
}

function where(session: PrSession | undefined, uri: vscode.Uri, line0: number): string {
  if (uri.scheme !== 'file') {
    return path.posix.basename(uri.path);
  }
  const rel =
    session && session.contains(uri.fsPath) ? session.relative(uri.fsPath) : vscode.workspace.asRelativePath(uri, false);
  return `${rel}:${line0 + 1}`;
}

function withTimeout<T>(p: Thenable<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Find a function by name so a removed call can still be followed. Best effort. */
async function resolveByName(name: string): Promise<vscode.Location | undefined> {
  const symbols = await withTimeout(
    vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
      'vscode.executeWorkspaceSymbolProvider',
      name,
    ),
    2000,
    undefined,
  );
  const matches = (symbols ?? []).filter(
    (s) => CALLABLE_KINDS.has(s.kind) && bareName(s.name) === name && !isExternal(s.location.uri),
  );
  // Only follow it when there is exactly one candidate; a guess between several would mislead.
  return matches.length === 1 ? matches[0].location : undefined;
}

const EDGE_RANK: Record<EdgeChange, number> = { new: 0, modified: 1, removed: 2, unchanged: 3 };
const NODE_RANK: Record<NodeChange, number> = { new: 0, modified: 1, unchanged: 2 };

/** Keep everything the PR touches, then fill with internal nodes, then externals. */
function cap<T extends NodeVM>(nodes: T[], max: number): { kept: T[]; hidden: number } {
  if (nodes.length <= max) {
    return { kept: nodes, hidden: 0 };
  }
  const score = (n: NodeVM) => (n.edge !== 'unchanged' || n.node !== 'unchanged' ? 0 : n.external ? 2 : 1);
  const keep = new Set(
    nodes
      .map((n, i) => ({ i, s: score(n) }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .slice(0, max)
      .map((x) => x.i),
  );
  return { kept: nodes.filter((_n, i) => keep.has(i)), hidden: nodes.length - max };
}

export async function buildFlow(
  session: PrSession | undefined,
  uri: vscode.Uri,
  target: Callable,
  maxNodes: number,
): Promise<FlowResult> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const targets = new Map<string, NavTarget>();

  const focusFile = fileOf(session, uri);
  const start = target.range.start.line + 1;
  const end = target.range.end.line + 1;
  const stats = classifyRange(focusFile, start, end);
  const touching = focusFile ? hunksTouching(focusFile, start, end) : [];
  const removedText = touching.flatMap((h) => h.removed);

  let note: string | undefined;
  let incoming: vscode.CallHierarchyIncomingCall[] = [];
  let outgoing: vscode.CallHierarchyOutgoingCall[] = [];

  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>(
    'vscode.prepareCallHierarchy',
    uri,
    target.selectionRange.start,
  );
  const item = items?.[0];
  if (!item) {
    note = 'The language server gave no call hierarchy for this symbol, so callers and callees are unknown.';
  } else {
    [incoming, outgoing] = await Promise.all([
      Promise.resolve(
        vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[] | undefined>(
          'vscode.provideIncomingCalls',
          item,
        ),
      ).then((r) => r ?? [], () => []),
      Promise.resolve(
        vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[] | undefined>(
          'vscode.provideOutgoingCalls',
          item,
        ),
      ).then((r) => r ?? [], () => []),
    ]);
  }

  // ---- A function that calls itself is one thing looping, not its own caller and its own callee.
  const isSelf = (other: vscode.CallHierarchyItem): boolean =>
    other.uri.toString() === uri.toString() &&
    (other.selectionRange.start.isEqual(target.selectionRange.start) ||
      (bareName(other.name) === bareName(target.name) &&
        other.range.union(other.selectionRange).contains(target.selectionRange.start)));
  const selfSites = new Map<string, vscode.Range>();
  for (const r of [
    ...outgoing.filter((c) => isSelf(c.to)).flatMap((c) => c.fromRanges),
    ...incoming.filter((c) => isSelf(c.from)).flatMap((c) => c.fromRanges),
  ]) {
    selfSites.set(`${r.start.line}:${r.start.character}`, r);
  }
  outgoing = outgoing.filter((c) => !isSelf(c.to));
  incoming = incoming.filter((c) => !isSelf(c.from));
  let recursion: FocusVM['recursion'];
  if (selfSites.size > 0) {
    const ranges = [...selfSites.values()].sort((a, b) => a.start.compareTo(b.start));
    recursion = {
      edge: classifyCallEdge(focusFile, ranges.map((r) => r.start.line + 1), target.name, removedText),
      sites: ranges.map((r, j) => {
        const sid = `self${j}`;
        targets.set(sid, { uri, reveal: r });
        return { id: sid, line: r.start.line + 1 };
      }),
    };
  }

  // ---- Flows to: calls made by the focus function. Call sites live in the focus document.
  const calleeRows: Array<NodeVM & { order: number }> = outgoing.map((call, i) => {
    const id = `out${i}`;
    const lines = call.fromRanges.map((r) => r.start.line + 1);
    const to = call.to;
    targets.set(id, {
      uri: to.uri,
      reveal: to.selectionRange,
      focusAt: to.selectionRange.start,
      callable: callableOf(to),
    });
    const sites = call.fromRanges.map((r, j) => {
      const sid = `${id}s${j}`;
      targets.set(sid, { uri, reveal: r });
      return { id: sid, line: r.start.line + 1 };
    });
    const external = isExternal(to.uri);
    return {
      id,
      name: to.name,
      where: external ? to.detail || where(session, to.uri, to.selectionRange.start.line) : where(session, to.uri, to.selectionRange.start.line),
      edge: classifyCallEdge(focusFile, lines, to.name, removedText),
      node: classifyRange(fileOf(session, to.uri), to.range.start.line + 1, to.range.end.line + 1).change,
      external,
      clickable: true,
      sites,
      order: lines.length ? Math.min(...lines) : end,
    };
  });

  // ---- Calls the PR took out of this function (read from the removed lines).
  const known = outgoing.map((c) => bareName(c.to.name));
  const body = doc.getText(target.range);
  const removedCalls: Array<{ name: string; order: number }> = [];
  for (const h of touching) {
    // Like a diff: a removed call sits just before the lines that replaced it.
    // A pure deletion has no replacement; it sits just after the line it followed.
    const order = h.newCount > 0 ? Math.max(h.newStart, start) - 0.5 : h.newStart + 0.5;
    for (const name of findRemovedCalls(h.removed, body, known)) {
      if (!removedCalls.some((r) => r.name === name)) {
        removedCalls.push({ name, order });
      }
    }
  }
  const resolved = await Promise.all(
    removedCalls.map((rc, i) => (i < 12 ? resolveByName(rc.name) : Promise.resolve(undefined))),
  );
  removedCalls.forEach((rc, i) => {
    const id = `gone${i}`;
    const loc = resolved[i];
    if (loc) {
      targets.set(id, { uri: loc.uri, reveal: loc.range, focusAt: loc.range.start });
    }
    calleeRows.push({
      id,
      name: rc.name,
      where: loc ? where(session, loc.uri, loc.range.start.line) : 'no longer called here',
      edge: 'removed',
      node: 'unchanged',
      external: false,
      clickable: !!loc,
      sites: [],
      order: rc.order,
    });
  });
  // Top to bottom in the order the function reaches them.
  calleeRows.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  // ---- Flows from: callers of the focus function. Call sites live in each caller's document.
  const callerRows: NodeVM[] = incoming.map((call, i) => {
    const id = `in${i}`;
    const from = call.from;
    const fromFile = fileOf(session, from.uri);
    const lines = call.fromRanges.map((r) => r.start.line + 1);
    const fromStart = from.range.start.line + 1;
    const fromEnd = from.range.end.line + 1;
    const fromRemoved = fromFile ? hunksTouching(fromFile, fromStart, fromEnd).flatMap((h) => h.removed) : [];
    // Land on the call itself: that is the line that explains why this caller matters.
    const first = call.fromRanges[0] ?? from.selectionRange;
    const fromCallable = callableOf(from);
    targets.set(id, { uri: from.uri, reveal: first, focusAt: from.selectionRange.start, callable: fromCallable });
    const sites = call.fromRanges.map((r, j) => {
      const sid = `${id}s${j}`;
      targets.set(sid, { uri: from.uri, reveal: r, focusAt: from.selectionRange.start, callable: fromCallable });
      return { id: sid, line: r.start.line + 1 };
    });
    return {
      id,
      name: from.name,
      where: where(session, from.uri, from.selectionRange.start.line),
      edge: classifyCallEdge(fromFile, lines, target.name, fromRemoved),
      node: classifyRange(fromFile, fromStart, fromEnd).change,
      external: isExternal(from.uri),
      clickable: true,
      sites,
    };
  });
  callerRows.sort(
    (a, b) =>
      EDGE_RANK[a.edge] - EDGE_RANK[b.edge] ||
      NODE_RANK[a.node] - NODE_RANK[b.node] ||
      a.where.localeCompare(b.where),
  );

  const callers = cap(callerRows, maxNodes);
  const callees = cap(calleeRows, maxNodes);
  const strip = ({ order: _order, ...rest }: NodeVM & { order: number }): NodeVM => rest;

  return {
    targets,
    vm: {
      focus: {
        name: target.container ? `${target.container}.${target.name}` : target.name,
        where: where(session, uri, target.selectionRange.start.line),
        change: stats.change,
        added: stats.added,
        removed: stats.removed,
        recursion,
      },
      callers: callers.kept,
      callees: callees.kept.map(strip),
      hiddenCallers: callers.hidden,
      hiddenCallees: callees.hidden,
      note,
    },
  };
}
