// The smallest possible Hookstorm setup: a receiver for a provider with no preset (custom HMAC-SHA256
// signature), observed through a state probe only. No sink, no changes to how the handler does its work.
//
// It records a ledger entry per payment and is deliberately NOT idempotent, so Hookstorm finds duplicates.
// Set IDEMPOTENT=1 to see the same receiver pass.
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const SECRET = process.env.WEBHOOK_SECRET ?? 'test_secret_local';
const IDEMPOTENT = process.env.IDEMPOTENT === '1';
let ledger = [];

function verify(raw, signature = '') {
  const expected = createHmac('sha256', SECRET).update(raw).digest('hex');
  return (
    expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  );
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  // Test-only routes: mount these only in test environments.
  if (req.method === 'POST' && req.url === '/hookstorm/reset') {
    ledger = [];
    return res.writeHead(204).end();
  }
  if (req.method === 'GET' && req.url === '/hookstorm/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ledger }));
  }

  if (req.method === 'POST' && req.url === '/webhooks') {
    if (!verify(raw, req.headers['x-signature'])) return res.writeHead(401).end('bad signature');
    const { event, data } = JSON.parse(raw);
    if (event === 'payment.completed') {
      // An atomic check-and-insert. In SQL: INSERT ... ON CONFLICT (reference) DO NOTHING.
      if (!(IDEMPOTENT && ledger.some((row) => row.reference === data.reference)))
        ledger.push({ reference: data.reference, amount: data.amount });
    }
    return res.writeHead(200).end('ok');
  }
  res.writeHead(404).end();
});

const port = Number(process.env.PORT ?? 3003);
server.listen(port, '127.0.0.1', () =>
  console.log(`probe-only-receiver listening on http://127.0.0.1:${port}/webhooks`),
);
