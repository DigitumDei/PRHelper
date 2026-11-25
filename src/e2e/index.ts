/**
 * End-to-end check, run inside a real VS Code extension host against the fixture repo
 * from dev/make-fixture.js. It exercises the real language server, call hierarchy and git.
 *
 * Launched with: Code --extensionDevelopmentPath=<repo> --extensionTestsPath=<repo>/out/e2e/index.js <fixture>
 */
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestApi } from '../extension';
import { FlowResult, NodeVM, buildFlow } from '../flow';
import * as git from '../git';
import { PrSession } from '../session';
import { documentCallables, enclosingCallable } from '../symbols';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const brief = (n: NodeVM) => `${n.name} edge=${n.edge} node=${n.node}${n.clickable ? '' : ' (not clickable)'}`;

async function flowFor(session: PrSession, uri: vscode.Uri, name: string): Promise<FlowResult> {
  const callables = await documentCallables(uri);
  const target = callables.find((c) => c.name === name);
  assert.ok(target, `symbol ${name} not found in ${uri.fsPath}`);
  return buildFlow(session, uri, target, 40);
}

async function main(report: Record<string, unknown>): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'no workspace folder open');
  const root = await git.repoRoot(folder.uri.fsPath);
  const base = await git.defaultBase(root);
  assert.equal(base, 'main');
  const session = await PrSession.load(root, base);
  report.files = session.files.map((f) => `${f.status} ${f.newPath}`);
  assert.deepEqual(report.files, ['modified src/api.ts', 'added src/inventory.ts', 'modified src/orders.ts']);

  const orders = vscode.Uri.file(path.join(root, 'src', 'orders.ts'));
  await vscode.window.showTextDocument(orders);

  // The TypeScript server needs a moment to load the project; wait until it sees both callers.
  let result: FlowResult | undefined;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      result = await flowFor(session, orders, 'submitOrder');
      if (result.vm.callers.length >= 2 && result.vm.callees.length >= 4) {
        break;
      }
    } catch (err) {
      report.lastRetryError = String(err);
    }
    await sleep(1500);
  }
  assert.ok(result, 'no flow was produced');
  const { vm, targets } = result;
  report.focus = vm.focus;
  report.callers = vm.callers.map(brief);
  report.callees = vm.callees.map(brief);
  report.note = vm.note;

  assert.equal(vm.focus.change, 'modified');
  const callee = (n: string) => vm.callees.find((c) => c.name === n);
  const caller = (n: string) => vm.callers.find((c) => c.name === n);
  assert.deepEqual([callee('reserveStock')?.edge, callee('reserveStock')?.node], ['new', 'new']);
  assert.deepEqual([callee('chargeCard')?.edge, callee('chargeCard')?.node], ['modified', 'unchanged']);
  assert.deepEqual([callee('audit')?.edge, callee('audit')?.node], ['unchanged', 'unchanged']);
  assert.deepEqual([callee('publish')?.edge, callee('publish')?.node], ['new', 'unchanged']);
  assert.equal(callee('sendReceipt')?.edge, 'removed');
  assert.deepEqual([caller('checkoutV2')?.edge, caller('checkoutV2')?.node], ['new', 'new']);
  assert.deepEqual([caller('createOrderHandler')?.edge, caller('createOrderHandler')?.node], ['unchanged', 'unchanged']);
  // Callees are listed in the order the function reaches them.
  assert.deepEqual(
    vm.callees.filter((c) => !c.external).map((c) => c.name),
    ['reserveStock', 'chargeCard', 'audit', 'sendReceipt', 'publish'],
  );

  // One step further: follow the new callee, as a click on its card would.
  const next = targets.get(callee('reserveStock')!.id);
  assert.ok(next?.focusAt, 'reserveStock has no navigation target');
  const landed = enclosingCallable(await documentCallables(next.uri), next.focusAt);
  assert.equal(landed?.name, 'reserveStock');
  const step = await buildFlow(session, next.uri, landed, 40);
  report.step = { focus: step.vm.focus, callers: step.vm.callers.map(brief) };
  assert.equal(step.vm.focus.change, 'new');
  assert.equal(step.vm.callers.find((c) => c.name === 'submitOrder')?.edge, 'new');

  // A function that calls itself: a loop on the centre, and not listed as its own caller or callee.
  const inventory = vscode.Uri.file(path.join(root, 'src', 'inventory.ts'));
  const rec = await flowFor(session, inventory, 'countItems');
  report.recursion = {
    loop: rec.vm.focus.recursion,
    callers: rec.vm.callers.map(brief),
    callees: rec.vm.callees.filter((c) => !c.external).map(brief),
  };
  assert.equal(rec.vm.focus.recursion?.edge, 'new');
  assert.deepEqual(rec.vm.focus.recursion?.sites.map((s) => s.line), [6]);
  assert.deepEqual(rec.vm.callers.map((c) => c.name), ['reserveStock']);
  assert.equal(rec.vm.callees.some((c) => c.name === 'countItems'), false);
  // A function that does not call itself has no loop.
  assert.equal(vm.focus.recursion, undefined);

  // A step into untouched code is plain navigation: nothing marked.
  const plain = await flowFor(session, vscode.Uri.file(path.join(root, 'src', 'billing.ts')), 'chargeCard');
  report.plain = { focus: plain.vm.focus, callers: plain.vm.callers.map(brief) };
  assert.equal(plain.vm.focus.change, 'unchanged');
  assert.equal(plain.vm.callers.find((c) => c.name === 'submitOrder')?.edge, 'modified');

  // The extension itself: activates, registers its commands, and they run without throwing.
  const ext = vscode.extensions.all.find((e) => e.id.endsWith('.pr-flow'));
  assert.ok(ext, 'extension not found');
  await ext.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['prFlow.loadPullRequest', 'prFlow.compareWithRef', 'prFlow.refresh', 'prFlow.showFlowAtCursor', 'prFlow.back']) {
    assert.ok(commands.includes(id), `command ${id} is not registered`);
  }
  const editor = await vscode.window.showTextDocument(orders);
  editor.selection = new vscode.Selection(8, 4, 8, 4);
  await vscode.commands.executeCommand('prFlow.refresh');
  await vscode.commands.executeCommand('prFlow.showFlowAtCursor');
  report.commands = 'ran';

  // The click path, driven the way the panel drives it: every click must re-centre the flow.
  const api = (ext.exports as { __test: TestApi }).__test;
  const panel = () => api.lastPanelMessage() as PanelFlow;
  const focus = () => panel().model?.focus.name;
  const names = (side: 'callers' | 'callees') => panel().model.callers && panel().model[side].map((c) => c.name);
  const click = async (side: 'callers' | 'callees', name: string) => {
    const card = panel().model[side].find((c) => c.name === name);
    assert.ok(card, `no "${name}" card under ${side} of ${focus()}; have: ${names(side)}`);
    await api.click(card.id);
  };
  const walk: string[] = [];
  report.walk = walk;
  const expectFocus = (name: string, how: string) => {
    walk.push(`${how} -> ${focus()}`);
    assert.equal(focus(), name, `after ${how}`);
  };

  expectFocus('submitOrder', 'show flow at cursor');

  // "Flows to", onto a one-line arrow function.
  await click('callees', 'publish');
  expectFocus('publish', 'click callee publish');
  assert.ok(names('callers').includes('submitOrder'), 'publish should list submitOrder as a caller');
  assert.deepEqual(panel().trail, ['submitOrder']);

  await api.back();
  expectFocus('submitOrder', 'back');
  assert.deepEqual(panel().trail, []);

  // "Flows to" twice, ending on a closure inside another function.
  await click('callees', 'audit');
  expectFocus('audit', 'click callee audit');
  await click('callees', 'count');
  expectFocus('count', 'click callee count');
  assert.deepEqual(panel().trail, ['submitOrder', 'audit']);
  // The cursor now sits inside `audit`. Following it must not pull the centre back out.
  await sleep(900);
  expectFocus('count', 'cursor-follow settles');

  // "Flows from", back up the chain and out to another file.
  await click('callers', 'audit');
  expectFocus('audit', 'click caller audit');
  await click('callers', 'submitOrder');
  expectFocus('submitOrder', 'click caller submitOrder');
  await click('callers', 'checkoutV2');
  expectFocus('checkoutV2', 'click caller checkoutV2');
  assert.ok(names('callees').includes('submitOrder'), 'checkoutV2 should list submitOrder as a callee');
}

interface PanelFlow {
  type: string;
  model: { focus: { name: string }; callers: NodeVM[]; callees: NodeVM[] };
  trail: string[];
}

export async function run(): Promise<void> {
  const out = process.env.PRFLOW_E2E_OUT;
  const report: Record<string, unknown> = {};
  try {
    await main(report);
    report.ok = true;
  } catch (err) {
    report.ok = false;
    report.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    throw err;
  } finally {
    if (out) {
      fs.writeFileSync(out, JSON.stringify(report, null, 2));
    }
  }
}
