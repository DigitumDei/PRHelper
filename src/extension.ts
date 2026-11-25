import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RangeStats, classifyRange } from './classify';
import { FileDiff } from './diff';
import { NavTarget, buildFlow } from './flow';
import * as git from './git';
import { PrSession } from './session';
import { Callable, documentCallables, enclosingCallable } from './symbols';
import { worktreePathFor } from './worktree';

const BASE_SCHEME = 'prflow-base';

// ---------------------------------------------------------------------------------------------
// Base-side file contents, so VS Code's own diff editor can show base vs working tree.
// ---------------------------------------------------------------------------------------------

class BaseContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly session: () => PrSession | undefined) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const session = this.session();
    if (!session || uri.query === 'empty') {
      return '';
    }
    try {
      return await git.showFile(session.root, uri.query, uri.path.replace(/^\//, ''));
    } catch {
      return '';
    }
  }
}

function baseUri(relPath: string, commit: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: '/' + relPath, query: commit });
}

// ---------------------------------------------------------------------------------------------
// "Changed in this PR": files, and under each file the functions the PR touches.
// ---------------------------------------------------------------------------------------------

type TreeNode =
  | { kind: 'file'; file: FileDiff }
  | { kind: 'symbol'; uri: vscode.Uri; callable: Callable; stats: RangeStats }
  | { kind: 'info'; text: string };

class ChangesTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly session: () => PrSession | undefined) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'info') {
      const item = new vscode.TreeItem(node.text);
      item.contextValue = 'info';
      return item;
    }
    if (node.kind === 'file') {
      const { file } = node;
      const rel = file.newPath ?? file.oldPath ?? '';
      const session = this.session();
      const head = session?.headPath(file);
      const expandable = !!head && !file.binary;
      const item = new vscode.TreeItem(
        path.posix.basename(rel),
        expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
      const added = file.hunks.reduce((n, h) => n + h.added.length, 0);
      const removed = file.hunks.reduce((n, h) => n + h.removed.length, 0);
      const dir = path.posix.dirname(rel);
      const state = file.status === 'modified' ? '' : ` · ${file.status}`;
      item.description = `+${added} −${removed}${state}${dir === '.' ? '' : ' · ' + dir}`;
      item.tooltip = rel;
      item.resourceUri = head ? vscode.Uri.file(head) : undefined;
      item.iconPath = vscode.ThemeIcon.File;
      item.command = { command: 'prFlow.openFile', title: 'Open changes', arguments: [node] };
      return item;
    }
    const { callable, stats } = node;
    const item = new vscode.TreeItem(callable.name, vscode.TreeItemCollapsibleState.None);
    item.description = `+${stats.added} −${stats.removed}${stats.change === 'new' ? ' · new' : ''}`;
    item.tooltip = callable.container ? `${callable.container}.${callable.name}` : callable.name;
    item.iconPath = new vscode.ThemeIcon(
      callable.kind === vscode.SymbolKind.Method ? 'symbol-method' : 'symbol-function',
      new vscode.ThemeColor(
        stats.change === 'new' ? 'gitDecoration.addedResourceForeground' : 'gitDecoration.modifiedResourceForeground',
      ),
    );
    item.command = { command: 'prFlow.openSymbol', title: 'Show flow', arguments: [node] };
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    const session = this.session();
    if (!session) {
      return [];
    }
    if (!node) {
      return session.files.map((file) => ({ kind: 'file', file }) as TreeNode);
    }
    if (node.kind !== 'file') {
      return [];
    }
    const head = session.headPath(node.file);
    if (!head) {
      return [];
    }
    const uri = vscode.Uri.file(head);
    let callables: Callable[];
    try {
      callables = await documentCallables(uri);
    } catch {
      return [{ kind: 'info', text: 'Could not read this file' }];
    }
    if (callables.length === 0) {
      return [{ kind: 'info', text: 'No functions found (is the language server running?)' }];
    }
    const touched: TreeNode[] = [];
    for (const callable of callables) {
      const stats = classifyRange(node.file, callable.range.start.line + 1, callable.range.end.line + 1);
      if (stats.change !== 'unchanged') {
        touched.push({ kind: 'symbol', uri, callable, stats });
      }
    }
    return touched.length ? touched : [{ kind: 'info', text: 'Changes are outside any function' }];
  }
}

// ---------------------------------------------------------------------------------------------
// The flow panel (a webview). All drawing happens in media/flow.js; this side only sends models.
// ---------------------------------------------------------------------------------------------

type PanelEvent =
  | { type: 'ready' }
  | { type: 'open'; id: string }
  | { type: 'back' }
  | { type: 'trail'; index: number }
  | { type: 'source' };

class FlowView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private last: unknown = { type: 'hint', text: 'Put the cursor inside a function to see where it flows from and to.' };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onEvent: (e: PanelEvent) => void,
  ) {}

  get visible(): boolean {
    return !!this.view?.visible;
  }

  get lastMessage(): unknown {
    return this.last;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.onDidReceiveMessage((e: PanelEvent) => {
      if (e.type === 'ready') {
        void view.webview.postMessage(this.last);
      } else {
        this.onEvent(e);
      }
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'flow.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'flow.js'));
    view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>PR Flow</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  post(message: unknown): void {
    this.last = message;
    void this.view?.webview.postMessage(message);
  }
}

// ---------------------------------------------------------------------------------------------
// Controller: owns the session, the current focus, and the trail of where you have been.
// ---------------------------------------------------------------------------------------------

interface FocusEntry {
  key: string;
  uri: vscode.Uri;
  position: vscode.Position;
  name: string;
  /** The function itself, kept so Back and Refresh can return to it without looking it up again. */
  callable: Callable;
}

/** Hooks for the end-to-end check, so it can drive the panel the way a click would. */
export interface TestApi {
  lastPanelMessage(): unknown;
  sessionLabel(): string | undefined;
  changedFiles(): string[];
  showLastCommit(): Promise<void>;
  click(id: string): Promise<void>;
  back(): Promise<void>;
}

const MAX_TRAIL = 30;

class Controller implements vscode.Disposable {
  private session?: PrSession;
  private autoLoadTried = false;
  private current?: FocusEntry;
  private inflight?: { key: string; uri: vscode.Uri; range: vscode.Range };
  private trail: FocusEntry[] = [];
  private targets = new Map<string, NavTarget>();
  private seq = 0;
  private cursorTimer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tree: ChangesTree;
  private readonly treeView: vscode.TreeView<TreeNode>;
  private readonly flow: FlowView;
  private readonly status: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.tree = new ChangesTree(() => this.session);
    this.treeView = vscode.window.createTreeView('prFlow.changes', { treeDataProvider: this.tree });
    this.flow = new FlowView(context.extensionUri, (e) => void this.onPanelEvent(e));
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.status.command = 'prFlow.selectSource';

    const cmd = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
    this.disposables.push(
      this.treeView,
      this.status,
      vscode.window.registerWebviewViewProvider('prFlow.flow', this.flow, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new BaseContentProvider(() => this.session)),
      cmd('prFlow.loadPullRequest', () => this.guard(() => this.loadPullRequest())),
      cmd('prFlow.compareWithRef', () => this.guard(() => this.compareWithRef())),
      cmd('prFlow.showCommit', () => this.guard(() => this.showCommit())),
      cmd('prFlow.refresh', () => this.guard(() => this.refresh())),
      cmd('prFlow.selectSource', () => this.guard(() => this.selectSource())),
      cmd('prFlow.showFlowAtCursor', () => this.guard(() => this.showFlowAtCursor())),
      cmd('prFlow.back', () => this.guard(() => this.back())),
      cmd('prFlow.openFile', (node: TreeNode) => this.guard(() => this.openFileNode(node))),
      cmd('prFlow.openSymbol', (node: TreeNode) => this.guard(() => this.openSymbolNode(node))),
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
    );

    void this.ensureSession();
  }

  dispose(): void {
    clearTimeout(this.cursorTimer);
    clearTimeout(this.saveTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  private async guard(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      void vscode.window.showErrorMessage(`PR Flow: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- session -------------------------------------------------------------------------------

  private async findRoot(): Promise<string | undefined> {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder =
      (active?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(active) : undefined) ??
      vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    try {
      return await git.repoRoot(folder.uri.fsPath);
    } catch {
      return undefined;
    }
  }

  private async requireRoot(): Promise<string> {
    const root = this.session?.root ?? (await this.findRoot());
    if (!root) {
      throw new Error('Open a folder that is inside a git repository first.');
    }
    return root;
  }

  private async baseForPullRequest(root: string, pr: git.PullRequest): Promise<string> {
    const remoteBase = `origin/${pr.baseRefName}`;
    return (await git.refExists(root, remoteBase)) ? remoteBase : pr.baseRefName;
  }

  /**
   * On first use, load something sensible without being asked. In order: the commit itself when
   * the folder is on a detached HEAD; the open pull request for the branch; a comparison with the
   * default branch; and when that comparison is empty, the latest commit.
   */
  private async ensureSession(): Promise<void> {
    if (this.session || this.autoLoadTried) {
      return;
    }
    this.autoLoadTried = true;
    try {
      const root = await this.findRoot();
      if (!root) {
        return;
      }
      if ((await git.currentBranch(root)) === 'HEAD') {
        // Detached: this folder is a checkout of one commit, so show that commit.
        this.setSession(await PrSession.loadCommit(root));
        return;
      }
      const detect = vscode.workspace.getConfiguration('prFlow').get<boolean>('detectPullRequest', true);
      const pr = detect ? await git.pullRequestForCurrentBranch(root) : undefined;
      if (this.session) {
        return; // the user loaded something while gh was answering
      }
      if (pr) {
        const base = await this.baseForPullRequest(root, pr);
        this.setSession(await PrSession.load(root, base, `PR #${pr.number} vs ${base}`));
        return;
      }
      const base = await git.defaultBase(root);
      const session = base ? await PrSession.load(root, base) : undefined;
      // Nothing differs from the default branch: typically sitting on main just after a merge.
      // An empty list helps nobody, so show what the latest commit brought in instead.
      this.setSession(session && session.files.length > 0 ? session : await PrSession.loadCommit(root));
    } catch {
      // No base to compare with; the panel still works as plain navigation.
    }
  }

  private setSession(session: PrSession): void {
    this.session = session;
    const n = session.files.length;
    this.treeView.description = session.label;
    this.treeView.message =
      n > 0 ? undefined : session.fixedStart ? 'This commit changes no files.' : `No changes against ${session.baseRef}.`;
    const icon = session.fixedStart ? 'git-commit' : 'git-pull-request';
    this.status.text = `$(${icon}) ${session.label} · ${n} file${n === 1 ? '' : 's'}`;
    this.status.tooltip = 'PR Flow: choose what to compare against';
    this.status.show();
    this.tree.refresh();
    if (this.current) {
      void this.focusOn(this.current.uri, this.current.position, {
        force: true,
        push: false,
        callable: this.current.callable,
      });
    }
  }

  private async loadPullRequest(): Promise<void> {
    const root = await this.requireRoot();
    const prs = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'PR Flow: listing pull requests' },
      () => git.listPullRequests(root),
    );
    if (prs.length === 0) {
      void vscode.window.showInformationMessage('PR Flow: no open pull requests found for this repository.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      prs.map((pr) => ({
        label: `#${pr.number} ${pr.title}`,
        description: `${pr.headRefName} → ${pr.baseRefName}`,
        detail: [pr.author?.login, pr.isDraft ? 'draft' : undefined].filter(Boolean).join(' · ') || undefined,
        pr,
      })),
      { placeHolder: 'Pull request to review', matchOnDescription: true, matchOnDetail: true },
    );
    if (!picked) {
      return;
    }
    const { pr } = picked;
    const branch = await git.currentBranch(root);
    if (branch !== pr.headRefName) {
      // Git allows a branch in only one worktree. If the PR already lives in one, review it there.
      const trees = await git.listWorktrees(root);
      const elsewhere = trees.find((w) => w.branch === pr.headRefName);
      if (elsewhere) {
        const here = 'Open in This Window';
        const fresh = 'Open in New Window';
        const choice = await vscode.window.showInformationMessage(
          `PR #${pr.number} is already checked out in a worktree.`,
          { modal: true, detail: `${elsewhere.path}\n\nOpen that folder to review it. PR Flow picks the pull request up from the branch.` },
          here,
          fresh,
        );
        if (choice) {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(elsewhere.path), {
            forceNewWindow: choice === fresh,
          });
        }
        return;
      }
      // The language server reads files on disk, so the PR has to be checked out somewhere to be
      // traced. A worktree of its own leaves this folder's branch and uncommitted work alone.
      const configured = vscode.workspace.getConfiguration('prFlow').get<string>('worktreeDirectory', '.worktrees');
      const dest = worktreePathFor(trees, configured, pr.headRefName, `pr-${pr.number}`, fs.existsSync);
      const unignored = await this.showsAsUntracked(root, dest);
      const newWindow = 'Worktree in New Window';
      const thisWindow = 'Worktree in This Window';
      const inPlace = 'Check Out Here';
      const go = await vscode.window.showInformationMessage(
        `PR #${pr.number} is on "${pr.headRefName}" but this folder is on "${branch}".`,
        {
          modal: true,
          detail:
            `A worktree would be created at:\n${dest}\n\n` +
            (unignored ? 'That folder is not git-ignored here, so it will show up as untracked in this checkout.\n\n' : '') +
            `"${inPlace}" switches this folder's branch instead.`,
        },
        newWindow,
        thisWindow,
        inPlace,
      );
      if (!go) {
        return;
      }
      if (go !== inPlace) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Creating worktree for PR #${pr.number}` },
          async () => {
            await git.addDetachedWorktree(root, dest);
            try {
              await git.checkoutPullRequest(dest, pr.number);
            } catch (err) {
              // Do not leave a half-made worktree behind; it holds nothing but the checkout we just made.
              await git.removeWorktree(root, dest).catch(() => undefined);
              throw err;
            }
          },
        );
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), {
          forceNewWindow: go === newWindow,
        });
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Checking out PR #${pr.number}` },
        () => git.checkoutPullRequest(root, pr.number),
      );
    }
    const base = await this.baseForPullRequest(root, pr);
    this.setSession(await PrSession.load(root, base, `PR #${pr.number} vs ${base}`));
    await vscode.commands.executeCommand('prFlow.changes.focus');
  }

  /** A worktree folder inside the checkout that git does not ignore would be listed as untracked there. */
  private async showsAsUntracked(root: string, dest: string): Promise<boolean> {
    const inside = !path.relative(root, dest).startsWith('..');
    return inside && !(await git.isIgnored(root, dest));
  }

  /** Review the commit this folder has checked out: its parent against the working tree. */
  private async showLastCommit(): Promise<void> {
    const root = await this.requireRoot();
    this.setSession(await PrSession.loadCommit(root));
    await vscode.commands.executeCommand('prFlow.changes.focus');
  }

  private async showCommit(): Promise<void> {
    const root = await this.requireRoot();
    const commits = await git.recentCommits(root, 100);
    if (commits.length === 0) {
      void vscode.window.showInformationMessage('PR Flow: this repository has no commits yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      commits.map((commit, i) => ({
        label: `${commit.parents.length > 1 ? '$(git-merge)' : '$(git-commit)'} ${commit.subject}`,
        description: commit.short + (i === 0 ? ' · checked out here' : ''),
        detail: `${commit.author} · ${commit.when}`,
        commit,
      })),
      { placeHolder: 'Commit to look at', matchOnDescription: true, matchOnDetail: true },
    );
    if (!picked) {
      return;
    }
    const { commit } = picked;
    if (commit.sha === commits[0].sha) {
      await this.showLastCommit();
      return;
    }

    // An older commit. The flow is traced from the files on disk, and those are a later version,
    // so the commit needs a checkout of its own. A folder on a detached HEAD shows its commit.
    const here = 'This Window';
    const fresh = 'New Window';
    const trees = await git.listWorktrees(root);
    const existing = trees.find((w) => w.head === commit.sha && !w.branch);
    if (existing) {
      const choice = await vscode.window.showInformationMessage(
        `Commit ${commit.short} is already checked out in a worktree.`,
        { modal: true, detail: `${existing.path}\n\nOpen that folder to look at it.` },
        `Open in ${fresh}`,
        `Open in ${here}`,
      );
      if (choice) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(existing.path), {
          forceNewWindow: choice.endsWith(fresh),
        });
      }
      return;
    }
    const configured = vscode.workspace.getConfiguration('prFlow').get<string>('worktreeDirectory', '.worktrees');
    const dest = worktreePathFor(trees, configured, `commit-${commit.short}`, commit.short, fs.existsSync);
    const unignored = await this.showsAsUntracked(root, dest);
    const choice = await vscode.window.showInformationMessage(
      `Commit ${commit.short} is not the one checked out in this folder.`,
      {
        modal: true,
        detail:
          'The flow is traced from the files on disk, so an older commit needs a checkout of its own.\n\n' +
          `A worktree would be created at:\n${dest}` +
          (unignored ? '\n\nThat folder is not git-ignored here, so it will show up as untracked in this checkout.' : ''),
      },
      `Worktree in ${fresh}`,
      `Worktree in ${here}`,
    );
    if (!choice) {
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating worktree for commit ${commit.short}` },
      () => git.addDetachedWorktree(root, dest, commit.sha),
    );
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), {
      forceNewWindow: choice.endsWith(fresh),
    });
  }

  private async compareWithRef(): Promise<void> {
    const root = await this.requireRoot();
    const refs = await git.listRefs(root);
    const picked = await vscode.window.showQuickPick(refs, {
      placeHolder: 'Compare the working tree against the merge-base with…',
    });
    if (picked) {
      this.setSession(await PrSession.load(root, picked));
    }
  }

  private async refresh(): Promise<void> {
    if (this.session) {
      this.setSession(await this.session.reload());
    } else {
      this.autoLoadTried = false;
      await this.ensureSession();
    }
  }

  private async selectSource(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(git-pull-request) Load pull request…', run: () => this.loadPullRequest() },
        { label: '$(git-compare) Compare with branch or ref…', run: () => this.compareWithRef() },
        { label: '$(git-commit) Show a commit…', run: () => this.showCommit() },
        { label: '$(refresh) Refresh', run: () => this.refresh() },
      ],
      { placeHolder: this.session ? `Currently: ${this.session.label}` : 'Nothing loaded yet' },
    );
    await picked?.run();
  }

  // ---- opening code --------------------------------------------------------------------------

  private async openDiff(session: PrSession, file: FileDiff, selection?: vscode.Range): Promise<void> {
    const head = session.headPath(file);
    if (!head) {
      // Deleted in the PR: only the base side exists.
      const doc = await vscode.workspace.openTextDocument(baseUri(file.oldPath ?? '', session.mergeBase));
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    const right = vscode.Uri.file(head);
    if (file.binary) {
      await vscode.commands.executeCommand('vscode.open', right);
      return;
    }
    const left =
      file.status === 'added' || !file.oldPath
        ? vscode.Uri.from({ scheme: BASE_SCHEME, path: '/' + file.newPath, query: 'empty' })
        : baseUri(file.oldPath, session.mergeBase);
    const title = `${path.basename(head)} (${session.baseRef} ↔ working tree)`;
    const options: vscode.TextDocumentShowOptions = { preview: true, selection };
    await vscode.commands.executeCommand('vscode.diff', left, right, title, options);
  }

  /** Changed files open as a diff, untouched files as a plain editor. */
  private async reveal(uri: vscode.Uri, range: vscode.Range): Promise<void> {
    const session = this.session;
    const file = session && uri.scheme === 'file' ? session.fileForPath(uri.fsPath) : undefined;
    if (session && file && !file.binary) {
      await this.openDiff(session, file, range);
    } else {
      await vscode.window.showTextDocument(uri, { preview: true, selection: range });
    }
  }

  private async openFileNode(node: TreeNode): Promise<void> {
    if (node.kind === 'file' && this.session) {
      await this.openDiff(this.session, node.file);
    }
  }

  private async openSymbolNode(node: TreeNode): Promise<void> {
    if (node.kind !== 'symbol') {
      return;
    }
    await vscode.commands.executeCommand('prFlow.flow.focus');
    await this.goTo({
      uri: node.uri,
      reveal: node.callable.selectionRange,
      focusAt: node.callable.selectionRange.start,
      callable: node.callable,
    });
  }

  // ---- focus and navigation ------------------------------------------------------------------

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    const doc = e.textEditor.document;
    if (doc.uri.scheme !== 'file' || !this.flow.visible) {
      return;
    }
    if (!vscode.workspace.getConfiguration('prFlow').get<boolean>('followCursor', true)) {
      return;
    }
    const position = e.selections[0].active;
    clearTimeout(this.cursorTimer);
    this.cursorTimer = setTimeout(() => {
      void this.guard(() => this.focusOn(doc.uri, position, { force: false, push: true, fromCursor: true }));
    }, 250);
  }

  private onSave(doc: vscode.TextDocument): void {
    if (!this.session || doc.uri.scheme !== 'file' || !this.session.contains(doc.uri.fsPath)) {
      return;
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.guard(() => this.refresh()), 800);
  }

  private async showFlowAtCursor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await vscode.commands.executeCommand('prFlow.flow.focus');
    await this.focusOn(editor.document.uri, editor.selection.active, { force: true, push: true });
  }

  private async goTo(target: NavTarget, push = true): Promise<void> {
    await this.reveal(target.uri, target.reveal);
    if (target.focusAt) {
      await this.focusOn(target.uri, target.focusAt, { force: false, push, callable: target.callable });
    }
  }

  /**
   * Centre the flow on a function.
   *
   * With `callable` (a click on a card, Back, Refresh) that exact function becomes the centre.
   * Without it (the cursor moved) the centre is the innermost function around `position`.
   */
  private async focusOn(
    uri: vscode.Uri,
    position: vscode.Position,
    opts: { force: boolean; push: boolean; callable?: Callable; fromCursor?: boolean },
  ): Promise<void> {
    let target: Callable | undefined;
    // The symbol list gives nicer names (it knows the enclosing class), so use it when it agrees.
    // Skip it for files outside the workspace: library typings can hold thousands of symbols.
    if (!opts.callable || vscode.workspace.getWorkspaceFolder(uri)) {
      try {
        target = enclosingCallable(await documentCallables(uri), position);
      } catch {
        target = undefined;
      }
    }
    if (opts.callable && !target?.selectionRange.start.isEqual(opts.callable.selectionRange.start)) {
      target = opts.callable;
    }
    if (!target) {
      // Outside any function: leave the last flow on screen rather than blanking it.
      return;
    }
    const at = target.selectionRange.start;
    const key = `${uri.toString()}#${at.line}:${at.character}`;
    if (!opts.force) {
      if (key === this.current?.key || key === this.inflight?.key) {
        return;
      }
      // A click can centre on something the symbol list does not have (a closure, a one-line
      // arrow function). The cursor then sits inside it, and following the cursor would pull the
      // centre back out to the enclosing function. Stay on the more specific one.
      const anchor = this.inflight ?? (this.current && { ...this.current, range: this.current.callable.range });
      if (
        opts.fromCursor &&
        anchor &&
        anchor.uri.toString() === uri.toString() &&
        anchor.range.contains(position) &&
        target.range.contains(anchor.range)
      ) {
        return;
      }
    }
    const seq = ++this.seq;
    this.inflight = { key, uri, range: target.range };
    this.flow.post({ type: 'loading', name: target.name });
    try {
      await this.ensureSession();
      const maxNodes = vscode.workspace.getConfiguration('prFlow').get<number>('maxNodes', 40);
      const result = await buildFlow(this.session, uri, target, Math.max(5, maxNodes));
      if (seq !== this.seq) {
        return;
      }
      if (opts.push && this.current && this.current.key !== key) {
        this.trail.push(this.current);
        if (this.trail.length > MAX_TRAIL) {
          this.trail.shift();
        }
      }
      this.current = { key, uri, position: at, name: target.name, callable: target };
      this.targets = result.targets;
      this.flow.post({
        type: 'flow',
        model: result.vm,
        trail: this.trail.slice(-4).map((t) => t.name),
        trailOffset: Math.max(0, this.trail.length - 4),
        source: this.session?.label ?? null,
      });
    } finally {
      if (this.inflight?.key === key) {
        this.inflight = undefined;
      }
    }
  }

  private async back(steps = 1): Promise<void> {
    let entry: FocusEntry | undefined;
    for (let i = 0; i < steps; i++) {
      entry = this.trail.pop() ?? entry;
    }
    if (entry) {
      await this.goTo(
        {
          uri: entry.uri,
          reveal: new vscode.Range(entry.position, entry.position),
          focusAt: entry.position,
          callable: entry.callable,
        },
        false,
      );
    }
  }

  testApi(): TestApi {
    return {
      lastPanelMessage: () => this.flow.lastMessage,
      sessionLabel: () => this.session?.label,
      changedFiles: () => (this.session?.files ?? []).map((f) => `${f.status} ${f.newPath ?? f.oldPath}`),
      showLastCommit: () => this.showLastCommit(),
      click: (id) => this.onPanelEvent({ type: 'open', id }),
      back: () => this.onPanelEvent({ type: 'back' }),
    };
  }

  private async onPanelEvent(e: PanelEvent): Promise<void> {
    await this.guard(async () => {
      switch (e.type) {
        case 'open': {
          const target = this.targets.get(e.id);
          if (target) {
            await this.goTo(target);
          }
          break;
        }
        case 'back':
          await this.back();
          break;
        case 'trail':
          await this.back(this.trail.length - e.index);
          break;
        case 'source':
          await this.selectSource();
          break;
        default:
          break;
      }
    });
  }
}

export function activate(context: vscode.ExtensionContext): { __test: TestApi } {
  const controller = new Controller(context);
  context.subscriptions.push(controller);
  return { __test: controller.testApi() };
}

export function deactivate(): void {}
