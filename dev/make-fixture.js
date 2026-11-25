// Builds a small TypeScript repo with a base commit on `main` and a change on `feature`,
// used by the end-to-end check (src/e2e). Usage: node dev/make-fixture.js <empty-dir>
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node dev/make-fixture.js <dir>');
  process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], {
    cwd: dir,
    stdio: 'pipe',
  });
const write = (rel, lines) => fs.writeFileSync(path.join(dir, rel), lines.join('\n') + '\n');

write('tsconfig.json', ['{ "compilerOptions": { "target": "ES2022", "module": "commonjs", "strict": true }, "include": ["src"] }']);
write('src/types.ts', ['export interface Cart {', '  items: string[];', '  total: number;', '}']);
write('src/billing.ts', ['export async function chargeCard(user: string, total: number) {', '  return { user, total };', '}']);
write('src/email.ts', ['export async function sendReceipt(user: string) {', '  return user;', '}']);
// `count` is a closure and `publish` a one-line arrow function: neither is in the file's symbol
// list as a function, but both are real steps in the flow and must be clickable.
write('src/audit.ts', [
  "import { Cart } from './types';",
  '',
  'export function audit(cart: Cart) {',
  '  const count = (items: string[]) => items.length;',
  '  return count(cart.items);',
  '}',
]);
write('src/queue.ts', ['export const publish = async (topic: string, payload: unknown) => [topic, payload];']);
write('src/orders.ts', [
  "import { audit } from './audit';",
  "import { chargeCard } from './billing';",
  "import { sendReceipt } from './email';",
  "import { Cart } from './types';",
  '',
  'export async function submitOrder(cart: Cart, user: string) {',
  '  await chargeCard(user, cart.total);',
  '  audit(cart);',
  '  await sendReceipt(user);',
  '  return true;',
  '}',
]);
write('src/api.ts', [
  "import { submitOrder } from './orders';",
  "import { Cart } from './types';",
  '',
  'export async function createOrderHandler(cart: Cart, user: string) {',
  '  return submitOrder(cart, user);',
  '}',
]);

git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-q', '-m', 'base');
git('checkout', '-q', '-b', 'feature');

write('src/inventory.ts', ['export async function reserveStock(items: string[]) {', '  return items.length;', '}']);
write('src/orders.ts', [
  "import { audit } from './audit';",
  "import { chargeCard } from './billing';",
  "import { reserveStock } from './inventory';",
  "import { publish } from './queue';",
  "import { Cart } from './types';",
  '',
  'export async function submitOrder(cart: Cart, user: string) {',
  '  await reserveStock(cart.items);',
  '  const receipt = await chargeCard(user, cart.total);',
  '  audit(cart);',
  "  await publish('order.paid', receipt);",
  '  return receipt;',
  '}',
]);
write('src/api.ts', [
  "import { submitOrder } from './orders';",
  "import { Cart } from './types';",
  '',
  'export async function createOrderHandler(cart: Cart, user: string) {',
  '  return submitOrder(cart, user);',
  '}',
  '',
  'export async function checkoutV2(cart: Cart, user: string) {',
  '  const receipt = await submitOrder(cart, user);',
  '  return { receipt };',
  '}',
]);
git('add', '-A');
git('commit', '-q', '-m', 'feature: reserve stock, publish instead of emailing');
console.log('fixture ready at ' + dir);
