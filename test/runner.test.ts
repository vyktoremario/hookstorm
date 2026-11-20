import { describe, expect, it } from 'vitest';
import { checkReachable, UnreachableError } from '../src/runner.js';
import { fakeReceiver, freePort } from './helpers.js';

describe('checkReachable', () => {
  it('resolves when the target accepts connections', async () => {
    const rx = await fakeReceiver();
    try {
      await expect(checkReachable(rx.url)).resolves.toBeUndefined();
    } finally {
      await rx.close();
    }
  });

  it('rejects with a clear error when nothing listens', async () => {
    const url = `http://127.0.0.1:${await freePort()}/x`;
    const err = await checkReachable(url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnreachableError);
    expect((err as Error).message).toMatch(/could not reach .* Is the receiver running\?/);
  });
});
