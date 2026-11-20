import { appendFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getPreset, type ProviderName } from './presets.js';

export interface RecordOptions {
  provider: ProviderName;
  port: number;
  host?: string;
  /** Optional URL to forward each request to, unchanged, so the app keeps working while recording. */
  forward?: string;
  out: string;
  log?: (line: string) => void;
  /** Print a troubleshooting hint if nothing has been recorded after this long (default 30 s; 0 disables). */
  idleHintMs?: number;
}

const IDLE_HINTS: Partial<Record<ProviderName, string>> = {
  stripe:
    'No events yet. Check `stripe listen` is running with --forward-to pointing here and an --events list, ' +
    'and that it uses the same account as your app\'s key: stripe listen --api-key "$STRIPE_SECRET_KEY" …',
};

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'accept-encoding',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
]);

/**
 * Transparent recorder. Point a provider's test mode (or `stripe listen --forward-to`) at it. Every request
 * body is saved byte-for-byte to a JSONL fixture. Signature headers are not saved: replays are re-signed
 * with your test secret (ADR-0005).
 */
export async function startRecorder(opts: RecordOptions): Promise<{ url: string; close(): Promise<void> }> {
  const preset = getPreset(opts.provider, () => ({}));
  const log = opts.log ?? (() => {});
  let n = 0;
  const idle =
    (opts.idleHintMs ?? 30_000) > 0
      ? setTimeout(() => {
          if (n === 0)
            log(
              IDLE_HINTS[opts.provider] ??
                'No events yet. Check the provider (or tunnel) sends webhooks to this address, in test mode.',
            );
        }, opts.idleHintMs ?? 30_000)
      : undefined;
  idle?.unref();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (HOP_HEADERS.has(k) || preset.stripHeaders.includes(k) || v === undefined) continue;
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      let json: Record<string, unknown> | undefined;
      try {
        json = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* non-JSON body is still recorded */
      }
      if (json?.livemode === true) {
        log('⚠ skipped a live-mode event: record from test mode only');
        res.writeHead(200).end();
        return;
      }
      n++;
      const type =
        (json?.type as string) ?? (json?.event as string) ?? headers['x-github-event'] ?? 'unknown';
      await appendFile(opts.out, JSON.stringify({ id: `evt_${n}`, type, headers, body: raw }) + '\n');
      log(`recorded #${n} ${type}`);

      if (!opts.forward) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"recorded":true}');
        return;
      }
      try {
        const fwdHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers))
          if (!HOP_HEADERS.has(k) && v !== undefined) fwdHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
        const upstream = await fetch(opts.forward, { method: req.method, headers: fwdHeaders, body: raw });
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'text/plain',
        });
        res.end(await upstream.text());
      } catch (e) {
        log(`forward failed: ${(e as Error).message}`);
        res.writeHead(502).end('hookstorm record: forward failed');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${opts.host ?? '127.0.0.1'}:${port}`,
    close: () =>
      new Promise<void>((r) => {
        clearTimeout(idle);
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
