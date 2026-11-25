import * as vscode from 'vscode';

/** A function-like symbol the flow can centre on. */
export interface Callable {
  name: string;
  container: string;
  kind: vscode.SymbolKind;
  /** Whole declaration, including the body. */
  range: vscode.Range;
  /** Just the name; this is where the call hierarchy is asked from. */
  selectionRange: vscode.Range;
  /** False for things that only look callable, such as a const holding an arrow function. */
  strict: boolean;
}

const STRICT = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
const LOOSE = new Set([
  vscode.SymbolKind.Variable,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Field,
]);
/** Names language servers invent for unnamed functions, e.g. `<function>` or `app.get() callback`. */
const ANONYMOUS = /^<.*>$|\bcallback$/;
const LOOKS_LIKE_FUNCTION = /=>|\bfunction\b/;

type AnySymbol = vscode.DocumentSymbol | vscode.SymbolInformation;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function rawSymbols(uri: vscode.Uri): Promise<AnySymbol[]> {
  // A freshly opened file can beat its language server; undefined means "no provider answered yet".
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await vscode.commands.executeCommand<AnySymbol[] | undefined>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    if (res) {
      return res;
    }
    await sleep(400);
  }
  return [];
}

function classify(kind: vscode.SymbolKind, name: string, range: vscode.Range, doc: vscode.TextDocument): boolean | undefined {
  if (ANONYMOUS.test(name)) {
    return undefined;
  }
  if (STRICT.has(kind)) {
    return true;
  }
  if (LOOSE.has(kind) && range.end.line > range.start.line) {
    const lastLine = Math.min(range.start.line + 1, doc.lineCount - 1);
    const opening = doc.getText(new vscode.Range(range.start, doc.lineAt(lastLine).range.end));
    if (LOOKS_LIKE_FUNCTION.test(opening)) {
      return false;
    }
  }
  return undefined;
}

function walk(sym: vscode.DocumentSymbol, container: string, doc: vscode.TextDocument, out: Callable[]): void {
  const strict = classify(sym.kind, sym.name, sym.range, doc);
  if (strict !== undefined) {
    out.push({
      name: sym.name,
      container,
      kind: sym.kind,
      range: sym.range,
      selectionRange: sym.selectionRange,
      strict,
    });
  }
  const next = container ? `${container}.${sym.name}` : sym.name;
  for (const child of sym.children ?? []) {
    walk(child, next, doc, out);
  }
}

/** All function-like symbols in a document, outermost first. */
export async function documentCallables(uri: vscode.Uri): Promise<Callable[]> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const out: Callable[] = [];
  for (const sym of await rawSymbols(uri)) {
    // VS Code hands back objects that are both shapes at once: every symbol has a `location`,
    // including the hierarchical ones. So test for the hierarchical fields, not for `location`,
    // or the children (class methods, functions inside functions) are never visited.
    if ('selectionRange' in sym && sym.selectionRange) {
      walk(sym, '', doc, out);
    } else if ('location' in sym) {
      // Truly flat SymbolInformation: no name range, so find the name on the first line.
      const range = sym.location.range;
      const strict = classify(sym.kind, sym.name, range, doc);
      if (strict === undefined) {
        continue;
      }
      const line = doc.lineAt(range.start.line).text;
      const col = line.indexOf(sym.name, range.start.character);
      const start = col >= 0 ? new vscode.Position(range.start.line, col) : range.start;
      out.push({
        name: sym.name,
        container: sym.containerName ?? '',
        kind: sym.kind,
        range,
        selectionRange: new vscode.Range(start, start.translate(0, col >= 0 ? sym.name.length : 0)),
        strict,
      });
    }
  }
  return out;
}

function size(r: vscode.Range): number {
  return (r.end.line - r.start.line) * 10000 + (r.end.character - r.start.character);
}

/** The innermost function around a position; real functions win over look-alikes. */
export function enclosingCallable(callables: Callable[], pos: vscode.Position): Callable | undefined {
  const around = callables.filter((c) => c.range.contains(pos));
  const pool = around.some((c) => c.strict) ? around.filter((c) => c.strict) : around;
  return pool.sort((a, b) => size(a.range) - size(b.range))[0];
}
