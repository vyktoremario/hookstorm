import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfigFile, resolveConfig } from '../src/config.js';
import { runInit } from '../src/init.js';
import { observations } from './helpers.js';

describe('hookstorm init', () => {
  it.each(['stripe', 'paystack', 'github', 'custom'] as const)(
    'writes a %s config that loads',
    async (provider) => {
      const dir = await mkdtemp(join(tmpdir(), `hookstorm-init-${provider}-`));
      const [configPath] = await runInit(provider, 'http://127.0.0.1:3000/webhooks', dir);
      const cfg = await resolveConfig(await loadConfigFile(configPath!), configPath);
      expect(cfg.preset.name).toBe(provider);
      expect(cfg.events.length).toBeGreaterThan(0);
      expect(cfg.invariants).toHaveLength(2);
    },
  );

  it('custom template signs with HMAC-SHA256 in x-signature', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hookstorm-init-sign-'));
    const [configPath] = await runInit('custom', 'http://127.0.0.1:3000/webhooks', dir);
    const cfg = await resolveConfig(await loadConfigFile(configPath!), configPath);
    const e = cfg.events[0]!;
    const headers = cfg.preset.sign({ body: e.body, secret: 's', event: e, attempt: 1, nowSec: 0 });
    expect(headers['x-signature']).toBe(createHmac('sha256', 's').update(e.body).digest('hex'));
  });

  it('the probe-only example invariant works, and is a no-op without a probe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hookstorm-init-probe-'));
    const [configPath] = await runInit('paystack', 'http://127.0.0.1:3000/webhooks', dir);
    const cfg = await resolveConfig(await loadConfigFile(configPath!), configPath);
    const inv = cfg.invariants[1]!;
    expect(await inv.check(observations({}))).toEqual([]);
    const v = await inv.check(
      observations({ state: { ledger: [{ reference: 'a' }, { reference: 'a' }, { reference: 'b' }] } }),
    );
    expect(v.map((x) => x.message)).toEqual(['a has 2 ledger entries']);
  });

  it('refuses to overwrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hookstorm-init-twice-'));
    await runInit('stripe', 'http://x', dir);
    await expect(runInit('stripe', 'http://x', dir)).rejects.toThrow(/already exists/);
  });
});
