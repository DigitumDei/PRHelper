// Runs src/e2e inside the installed VS Code, with a throwaway profile, against a fresh fixture repo.
// Usage: npm run e2e   (set VSCODE_EXE to override which VS Code is used)
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'prflow-e2e-'));
const fixture = path.join(work, 'fixture');
const resultFile = path.join(work, 'result.json');

function findCode() {
  if (process.env.VSCODE_EXE) return process.env.VSCODE_EXE;
  if (process.platform !== 'win32') return 'code';
  const cmd = execFileSync('where', ['code'], { encoding: 'utf8' }).split(/\r?\n/).find((l) => l.endsWith('code.cmd'));
  if (!cmd) throw new Error('VS Code not found on PATH; set VSCODE_EXE');
  return path.resolve(path.dirname(cmd), '..', 'Code.exe');
}

execFileSync(process.execPath, [path.join(repo, 'dev', 'make-fixture.js'), fixture], { stdio: 'inherit' });
const run = spawnSync(
  findCode(),
  [
    `--extensionDevelopmentPath=${repo}`,
    `--extensionTestsPath=${path.join(repo, 'out', 'e2e', 'index.js')}`,
    `--user-data-dir=${path.join(work, 'user-data')}`,
    `--extensions-dir=${path.join(work, 'extensions')}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    fixture,
  ],
  { stdio: 'inherit', env: { ...process.env, PRFLOW_E2E_OUT: resultFile, ELECTRON_RUN_AS_NODE: undefined } },
);

if (fs.existsSync(resultFile)) {
  console.log(fs.readFileSync(resultFile, 'utf8'));
} else {
  console.error('No result was written: VS Code did not get as far as running the check.');
}
try {
  fs.rmSync(work, { recursive: true, force: true });
} catch {
  // VS Code can hold the profile folder for a moment after exit; it lives in the temp dir anyway.
}
process.exit(run.status === 0 ? 0 : 1);
