// Plumbing shared by the buggy and fixed demo receivers, so the two server files differ only in their
// webhook handling logic. Nothing here is Hookstorm-specific except the two test-only routes.
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

export const SINK_URL = process.env.SINK_URL ?? 'http://127.0.0.1:4400/sink';
export const SECRET = process.env.PAYSTACK_SECRET_KEY ?? 'sk_test_hookstorm_demo';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Simulated database latency: makes check-then-act races real, as they are with a real DB. */
export const dbLatency = () => sleep(3 + Math.random() * 7);

/** A side effect in the outside world (payment ledger, email provider...). In tests, it is Hookstorm's sink. */
export async function effect(name, body) {
  const res = await fetch(`${SINK_URL}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${name} failed with ${res.status}`);
}

function verifyPaystack(raw, signature) {
  if (!signature) return false;
  const expected = createHmac('sha512', SECRET).update(raw).digest('hex');
  return (
    expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  );
}

/**
 * @param {object} app
 * @param {number} app.port
 * @param {string} app.name
 * @param {(event: any) => Promise<{status: number, body?: string} | void>} app.handlePaystack
 *   Return a response to send, or nothing if the handler already acknowledged via `ack()`.
 * @param {() => object} app.snapshot  state for GET /hookstorm/state
 * @param {() => void} app.reset
 */
export function serve({ port, name, handlePaystack, snapshot, reset }) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');

    // Test-only routes. In a real app, mount these only when NODE_ENV=test.
    if (req.url === '/hookstorm/reset' && req.method === 'POST') {
      reset();
      return res.writeHead(204).end();
    }
    if (req.url === '/hookstorm/state' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(snapshot()));
    }

    if (req.url === '/webhooks/paystack' && req.method === 'POST') {
      if (!verifyPaystack(raw, req.headers['x-paystack-signature']))
        return res.writeHead(401).end('bad signature');
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return res.writeHead(400).end('bad json');
      }
      let acked = false;
      const ack = (status = 200, body = 'ok') => {
        if (acked) return;
        acked = true;
        res.writeHead(status).end(body);
      };
      try {
        const out = await handlePaystack(event, ack);
        if (out) ack(out.status, out.body);
        else ack(200);
      } catch (err) {
        if (!acked) ack(500, String(err?.message ?? err));
      }
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(`${name} listening on http://127.0.0.1:${port}/webhooks/paystack`),
  );
  return server;
}
