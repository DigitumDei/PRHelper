import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { FileDiff, parseUnifiedDiff } from '../diff';
import { bareName, classifyCallEdge, classifyRange, findRemovedCalls, hunksTouching, isLineAdded } from '../classify';

// Head version of the file, for reference (1-based):
//  1 async function submitOrder(cart, user) {
//  2   await reserveStock(cart.items);                         (added)
//  3   const receipt = await chargeCard(user, cart.total);     (added, replaces old line 2)
//  4   audit(cart);
//  5   await queue.publish('order.paid', receipt);             (added, replaces sendReceipt)
//  6   return receipt;
//  7 }
//  8
//  9 function brandNew() {                                      (added)
// 10   return helper();                                         (added)
// 11 }                                                          (added)
const file: FileDiff = parseUnifiedDiff(
  [
    'diff --git a/submit.ts b/submit.ts',
    '--- a/submit.ts',
    '+++ b/submit.ts',
    '@@ -2 +2,2 @@',
    '-  await chargeCard(user, cart.total);',
    '+  await reserveStock(cart.items);',
    '+  const receipt = await chargeCard(user, cart.total);',
    '@@ -4 +5 @@',
    '-  await sendReceipt(user, cart);',
    "+  await queue.publish('order.paid', receipt);",
    '@@ -7,0 +9,3 @@',
    '+function brandNew() {',
    '+  return helper();',
    '+}',
    '',
  ].join('\n'),
)[0];

const body = [
  'async function submitOrder(cart, user) {',
  '  await reserveStock(cart.items);',
  '  const receipt = await chargeCard(user, cart.total);',
  '  audit(cart);',
  "  await queue.publish('order.paid', receipt);",
  '  return receipt;',
  '}',
].join('\n');

const removedInSubmit = hunksTouching(file, 1, 7).flatMap((h) => h.removed);

test('isLineAdded', () => {
  assert.equal(isLineAdded(file, 2), true);
  assert.equal(isLineAdded(file, 3), true);
  assert.equal(isLineAdded(file, 4), false);
  assert.equal(isLineAdded(file, 5), true);
});

test('classifyRange: modified, new and unchanged functions', () => {
  assert.deepEqual(classifyRange(file, 1, 7), { change: 'modified', added: 3, removed: 2 });
  assert.deepEqual(classifyRange(file, 9, 11), { change: 'new', added: 3, removed: 0 });
  assert.equal(classifyRange(file, 20, 30).change, 'unchanged');
  assert.equal(classifyRange(undefined, 1, 7).change, 'unchanged');
});

test('classifyRange: every function in an added file is new', () => {
  const added: FileDiff = { ...file, status: 'added' };
  assert.equal(classifyRange(added, 20, 30).change, 'new');
});

test('classifyCallEdge: new, moved, and untouched calls', () => {
  assert.equal(classifyCallEdge(file, [2], 'reserveStock', removedInSubmit), 'new');
  assert.equal(classifyCallEdge(file, [3], 'chargeCard', removedInSubmit), 'modified');
  assert.equal(classifyCallEdge(file, [4], 'audit', removedInSubmit), 'unchanged');
  assert.equal(classifyCallEdge(file, [5], 'publish', removedInSubmit), 'new');
  assert.equal(classifyCallEdge(undefined, [5], 'publish', []), 'unchanged');
});

test('classifyCallEdge: an extra call site on an added line is a modified edge', () => {
  assert.equal(classifyCallEdge(file, [2, 4], 'audit', removedInSubmit), 'modified');
});

test('classifyCallEdge: qualified names from the call hierarchy are matched by their last segment', () => {
  assert.equal(classifyCallEdge(file, [3], 'Billing::chargeCard<T>', removedInSubmit), 'modified');
});

test('findRemovedCalls: only calls that are gone from the function', () => {
  assert.deepEqual(findRemovedCalls(removedInSubmit, body, ['reserveStock', 'chargeCard', 'audit', 'publish']), [
    'sendReceipt',
  ]);
  // Even when the call hierarchy knows nothing, a call still present in the body is not "removed".
  assert.deepEqual(findRemovedCalls(removedInSubmit, body, []), ['sendReceipt']);
});

test('findRemovedCalls: ignores keywords, declarations, comments and turbofish noise', () => {
  const removed = [
    '  if (ready(x)) {',
    '  // legacy(x);',
    'fn old_helper(a: u32) -> u32 {',
    '  let v = parse::<u32>(s);',
    '  return Some(wrap(v));',
    '  items.iter().map(|i| convert(i)).collect::<Vec<_>>()',
  ];
  // `collect::<Vec<_>>()` is missed: nested generics are beyond the text heuristic.
  assert.deepEqual(findRemovedCalls(removed, '', []), ['ready', 'parse', 'wrap', 'iter', 'map', 'convert']);
});

test('bareName', () => {
  assert.equal(bareName('Foo::bar<T>(x)'), 'bar');
  assert.equal(bareName('obj.method'), 'method');
  assert.equal(bareName('plain'), 'plain');
});
