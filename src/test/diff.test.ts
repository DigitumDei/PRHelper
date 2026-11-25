import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../diff';

const SAMPLE = [
  'diff --git a/src/orders/submit.ts b/src/orders/submit.ts',
  'index 1111111..2222222 100644',
  '--- a/src/orders/submit.ts',
  '+++ b/src/orders/submit.ts',
  '@@ -2 +2,2 @@ async function submitOrder(cart, user) {',
  '-  await chargeCard(user, cart.total);',
  '+  await reserveStock(cart.items);',
  '+  const receipt = await chargeCard(user, cart.total);',
  '@@ -4 +5 @@ async function submitOrder(cart, user) {',
  '-  await sendReceipt(user, cart);',
  "+  await queue.publish('order.paid', receipt);",
  '@@ -9,2 +9,0 @@ function legacy() {',
  '-  --- a/not/a/header',
  '-  +++ b/also/not',
  'diff --git a/src/new file.ts b/src/new file.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new file.ts',
  '@@ -0,0 +1,2 @@',
  '+export const a = 1;',
  '+export const b = 2;',
  '\\ No newline at end of file',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-export {};',
  'diff --git a/old/name.ts b/new/name.ts',
  'similarity index 100%',
  'rename from old/name.ts',
  'rename to new/name.ts',
  'diff --git a/img/logo.png b/img/logo.png',
  'index 5555555..6666666 100644',
  'Binary files a/img/logo.png and b/img/logo.png differ',
  '',
].join('\n');

test('parses modified file hunks with line numbers and text', () => {
  const [f] = parseUnifiedDiff(SAMPLE);
  assert.equal(f.status, 'modified');
  assert.equal(f.newPath, 'src/orders/submit.ts');
  assert.equal(f.hunks.length, 3);
  assert.deepEqual(
    { s: f.hunks[0].newStart, c: f.hunks[0].newCount, os: f.hunks[0].oldStart, oc: f.hunks[0].oldCount },
    { s: 2, c: 2, os: 2, oc: 1 },
  );
  assert.deepEqual(f.hunks[0].removed, ['  await chargeCard(user, cart.total);']);
  assert.equal(f.hunks[0].added.length, 2);
});

test('removed lines that look like file headers stay inside their hunk', () => {
  const [f] = parseUnifiedDiff(SAMPLE);
  assert.equal(f.newPath, 'src/orders/submit.ts');
  assert.deepEqual(f.hunks[2].removed, ['  --- a/not/a/header', '  +++ b/also/not']);
  assert.equal(f.hunks[2].newCount, 0);
});

test('added, deleted, renamed and binary files', () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.equal(files.length, 5);
  const [, added, deleted, renamed, binary] = files;
  assert.deepEqual([added.status, added.oldPath, added.newPath], ['added', null, 'src/new file.ts']);
  assert.equal(added.hunks[0].added.length, 2);
  assert.deepEqual([deleted.status, deleted.oldPath, deleted.newPath], ['deleted', 'src/gone.ts', null]);
  assert.deepEqual([renamed.status, renamed.oldPath, renamed.newPath], ['renamed', 'old/name.ts', 'new/name.ts']);
  assert.equal(binary.binary, true);
  assert.equal(binary.newPath, 'img/logo.png');
});

test('handles CRLF output', () => {
  const files = parseUnifiedDiff(SAMPLE.replace(/\n/g, '\r\n'));
  assert.equal(files.length, 5);
  assert.deepEqual(files[0].hunks[0].removed, ['  await chargeCard(user, cart.total);']);
});
