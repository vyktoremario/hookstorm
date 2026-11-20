# ADR-0005: Re-sign every attempt with the user's test secret, using raw bytes

- Status: Accepted (2026-11-20)
- Date: 2026-11-20

## Context

Real receivers verify signatures. Replayed, duplicated or delayed events must still pass verification, or the test only exercises the "reject" path. Problems to handle:

- Stripe signs `timestamp.body`, and SDKs reject timestamps older than a tolerance (default 5 min). Replaying a recorded header fails, and so does a delayed one.
- Re-serialising JSON (key order, whitespace, unicode escaping) changes the bytes and breaks HMACs.
- Recorded headers were signed with whatever secret the provider used. That might be a production secret, which must never be needed or stored.

## Decision

- The fixture stores the **raw body string** exactly as received. Hookstorm sends those exact bytes.
- Recorded signature headers are **stripped**. Each attempt is re-signed at send time by the preset's signer, using the secret from config (`secret`, usually an env var holding the **test-mode** secret the local app is configured with).
- Per provider: Stripe uses `t=<now>,v1=HMAC-SHA256(secret, "t.body")`. Paystack uses `HMAC-SHA512(secret, body)` in `x-paystack-signature`. GitHub uses `sha256=HMAC-SHA256(secret, body)` in `X-Hub-Signature-256`, and keeps `X-GitHub-Delivery`/`X-GitHub-Event` identical across duplicates of the same event, as GitHub does on redelivery.
- `custom` provider: `sign({ body, secret, attempt, event }) => headers`.
- Signer tests verify output with the providers' official verification libraries.
- `record` warns if it detects a live-mode event (`livemode: true` for Stripe, `sk_live`-style hints) and refuses to save secrets.

## Consequences

- Receivers run their real verification code unchanged.
- Hookstorm can't prove the app rejects _real_ forged requests unless asked to. A `badSignature`/`staleSignature` fault is a stretch goal for that.
- Providers with asymmetric signatures (e.g. ed25519, if a preset ever needs one) would need a test key pair configured in the app. That's out of scope for v1 presets.
