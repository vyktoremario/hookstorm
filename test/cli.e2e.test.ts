import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { freePort, startExample } from './helpers.js';
import type { ChildProcess } from 'node:child_process';

const CLI = resolve('dist/cli.js');
const run = promisify(execFile);
const cli = async (args: string[], cwd = process.cwd()) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
};
const procs: ChildProcess[] = [];
afterAll(() => procs.forEach((p) => p.kill()));

// Runs against the built CLI (npm run build first; CI does).
describe.skipIf(!existsSync(CLI))('CLI (built)', () => {
  it('prints its version', async () => {
    const { stdout } = await cli(['--version']);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('init writes a config that loads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hookstorm-init-'));
    const r = await cli(['init', '--provider', 'paystack'], dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, 'hookstorm.config.ts'))).toBe(true);
    // Nothing listens on the target: run must fail cleanly with exit code 2, not crash.
    const port = await freePort();
    const out = await cli(
      [
        'run',
        '--runs',
        '1',
        '--target',
        `http://127.0.0.1:${port}/x`,
        '--sink-port',
        String(await freePort()),
      ],
      dir,
    );
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/could not reach .* Is the receiver running\?/);
    expect((await cli(['init'], dir)).code).toBe(2); // refuses to overwrite
  });

  it('reports config errors with exit code 2', async () => {
    const r = await cli(['run', '-c', 'does-not-exist.ts']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Config not found/);
  });

  it('exits 1 on violations and writes JSON and JUnit reports', async () => {
    const sinkPort = await freePort();
    const { port, proc } = await startExample('buggy', sinkPort);
    procs.push(proc);
    const dir = await mkdtemp(join(tmpdir(), 'hookstorm-rep-'));
    const r = await cli([
      'run',
      '-c',
      'examples/hookstorm.config.ts',
      '--target',
      `http://127.0.0.1:${port}/webhooks/paystack`,
      '--sink-port',
      String(sinkPort),
      '--seed',
      '1',
      '--runs',
      '2',
      '--json',
      join(dir, 'r.json'),
      '--junit',
      join(dir, 'r.xml'),
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/reproduce: hookstorm run .* --seed \d+ --runs 1/);
    const json = JSON.parse(await readFile(join(dir, 'r.json'), 'utf8'));
    expect(json.passed).toBe(false);
    expect(json.runs).toHaveLength(2);
    expect(json.runs[0].plan.seed).toBe(1);
    const xml = await readFile(join(dir, 'r.xml'), 'utf8');
    expect(xml).toMatch(/<testsuites name="hookstorm" tests="10" failures="\d+"/);
    expect(xml).toContain('<failure');
  });
});
