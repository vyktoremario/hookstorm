import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, type HookstormConfig, loadConfigFile, resolveConfig } from '../src/config.js';
import { atMostOnce } from '../src/invariants.js';

const base = (): HookstormConfig => ({
  target: 'http://127.0.0.1:3000/webhooks',
  provider: 'paystack',
  secret: 'sk_test',
  events: [{ body: { event: 'charge.success', data: { reference: 'r1' } } }],
  invariants: [atMostOnce('x', () => 'k')],
});

describe('resolveConfig', () => {
  it('applies defaults from the preset', async () => {
    const c = await resolveConfig(base());
    expect(c.maxAttempts).toBe(5);
    expect(c.timeoutMs).toBe(1000);
    expect(c.profileName).toBe('realistic');
    expect(c.events[0]!.type).toBe('charge.success');
    expect(c.eventKey(c.events[0]!)).toBe('r1');
  });

  it('resolves reset/probe paths against the (overridden) target', async () => {
    const c = await resolveConfig({ ...base(), reset: '/r', probe: 'http://other/state' }, undefined, {
      target: 'http://127.0.0.1:9999/hook',
    });
    expect(c.target).toBe('http://127.0.0.1:9999/hook');
    expect(c.reset).toBe('http://127.0.0.1:9999/r');
    expect(c.probe).toBe('http://other/state');
  });

  it.each<[string, Partial<HookstormConfig>, RegExp]>([
    ['missing target', { target: '' }, /target/],
    ['bad target', { target: 'not a url' }, /invalid target/],
    ['missing secret', { secret: undefined }, /secret/],
    ['no invariants', { invariants: [] }, /invariants/],
    ['custom without sign', { provider: 'custom' }, /sign/],
    ['bad profile', { profile: 'chaotic' as never }, /Unknown profile/],
  ])('rejects %s', async (_name, patch, msg) => {
    await expect(resolveConfig({ ...base(), ...patch })).rejects.toThrow(msg);
    await expect(resolveConfig({ ...base(), ...patch })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('loadConfigFile', () => {
  it("loads a TypeScript config that imports from 'hookstorm-cli', with a relative events path", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hookstorm-'));
    await writeFile(join(dir, 'events.jsonl'), '# comment\n{"id":"a","body":{"type":"ping","id":"evt_1"}}\n');
    await writeFile(
      join(dir, 'hookstorm.config.ts'),
      `import { defineConfig, atMostOnce } from 'hookstorm-cli';
const n: number = 1;
export default defineConfig({ target: 'http://127.0.0.1:1/x', provider: 'stripe', secret: 'whsec_' + n,
  events: './events.jsonl', invariants: [atMostOnce('x', (c) => c.body.id)] });`,
    );
    const path = join(dir, 'hookstorm.config.ts');
    const c = await resolveConfig(await loadConfigFile(path), path);
    expect(c.secret).toBe('whsec_1');
    expect(c.events.map((e) => [e.id, e.type])).toEqual([['a', 'ping']]);
    expect(c.preset.name).toBe('stripe');
  });

  it('reports a missing file clearly', async () => {
    await expect(loadConfigFile('/nope/hookstorm.config.ts')).rejects.toThrow(/Config not found/);
  });
});

describe('loadEnvForConfig', () => {
  it('loads .env next to the config by default, without overriding the shell', async () => {
    const { loadEnvForConfig } = await import('../src/config.js');
    const dir = await mkdtemp(join(tmpdir(), 'hookstorm-env-'));
    await writeFile(join(dir, '.env'), 'HS_TEST_A=file\nHS_TEST_B=file\n');
    process.env.HS_TEST_A = 'shell';
    try {
      expect(loadEnvForConfig(join(dir, 'hookstorm.config.ts'), undefined)).toBe(join(dir, '.env'));
      expect(process.env.HS_TEST_A).toBe('shell');
      expect(process.env.HS_TEST_B).toBe('file');
      expect(loadEnvForConfig(join(dir, 'hookstorm.config.ts'), false)).toBeUndefined();
      expect(() => loadEnvForConfig(join(dir, 'x.ts'), join(dir, 'missing.env'))).toThrow(
        /env file not found/,
      );
      expect(loadEnvForConfig(join(tmpdir(), 'nowhere', 'x.ts'), undefined)).toBeUndefined();
    } finally {
      delete process.env.HS_TEST_A;
      delete process.env.HS_TEST_B;
    }
  });
});
