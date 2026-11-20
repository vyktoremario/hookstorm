#!/usr/bin/env node
// The README demo: run Hookstorm against the buggy receiver (must fail) and the fixed receiver (must pass).
// Cross-platform replacement for a shell script, so it also runs on Windows.
//
//   node scripts/demo.mjs            # 5 seeds each, full output
//   node scripts/demo.mjs --smoke    # CI: 10 seeds each, quiet, exit 1 unless buggy=1 and fixed=0
//   RUNS=20 SEED=7 node scripts/demo.mjs
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const smoke = process.argv.includes('--smoke');
const runs = process.env.RUNS ?? (smoke ? '10' : '5');
const seed = process.env.SEED ?? '1';
const node = process.execPath;
const cli = join(root, 'dist', 'cli.js');

if (!existsSync(cli)) {
  console.log('dist/cli.js not found, building…');
  const b = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

function startReceiver(name) {
  const proc = spawn(node, [join(root, 'examples', `${name}-receiver`, 'server.mjs')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    proc.once('exit', (code) => reject(new Error(`${name} receiver exited early (code ${code})`)));
    proc.stdout.on('data', (d) => {
      if (String(d).includes('listening')) resolve(proc);
    });
  });
}

function hookstorm(port) {
  const target = `http://127.0.0.1:${port}/webhooks/paystack`;
  const args = [
    cli,
    'run',
    '-c',
    'examples/hookstorm.config.ts',
    '--target',
    target,
    '--seed',
    seed,
    '--runs',
    runs,
  ];
  if (smoke) args.push('--quiet');
  return new Promise((resolve) => {
    const p = spawn(node, args, { cwd: root, stdio: 'inherit' });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

const procs = [];
process.on('exit', () => procs.forEach((p) => p.kill()));
process.on('SIGINT', () => process.exit(130));

try {
  procs.push(await startReceiver('buggy'), await startReceiver('fixed'));
  console.log('━━━ 1/2  buggy receiver ━━━');
  const buggy = await hookstorm(3001);
  console.log('\n━━━ 2/2  fixed receiver ━━━');
  const fixed = await hookstorm(3002);
  console.log(`\nexit codes: buggy=${buggy} (expected 1), fixed=${fixed} (expected 0)`);
  process.exitCode = buggy === 1 && fixed === 0 ? 0 : 1;
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  // The receivers' stdout pipes keep this process alive, so stop them explicitly.
  procs.forEach((p) => p.kill());
}
