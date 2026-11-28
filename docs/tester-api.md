# Oruva Intents Tester API and Sandbox

The Tester API lets other developers use and test Oruva Intents on Stellar testnet. It is a sandbox: no real funds move, no mainnet path exists, and fiat payout is not supported. New here? Start with the five minute guide in `docs/developer-quickstart.md`.

## What a tester gets

- A self-issued sandbox API key (`oruva_test_...`), shown once at issuance and stored only as a hash.
- Capped test amounts: `inputAmount` up to 10 test units per intent.
- Per-key isolation: quotes, intents and idempotency keys belong to the issuing key only. Another key cannot see or act on your records.
- A simulated fill flow for same-chain Stellar intents, so a full quote, submit and settle cycle can be tested end to end.
- A reset endpoint that clears your own sandbox records.
- Rate limits: 60 requests per minute per key, and 5 key issuances per hour per label.

## Authentication

Send your sandbox key on every call except health and key issuance:

```http
x-api-key: oruva_test_...
```

Live keys (`oruva_live_...`) are rejected by the tester surface. Sandbox keys carry the scopes `intents:quote`, `intents:submit`, `intents:status` and `intents:refund`.

## Endpoints

### GET /tester/v1/health

Returns service state, network, caps and the route list. No key required.

```json
{
  "ok": true,
  "service": "oruva-stellar-intents-tester",
  "network": "stellar-testnet",
  "mode": "sandbox",
  "liveMoney": false,
  "maxInputAmount": 10
}
```

### POST /tester/v1/keys

Issues a sandbox key. Body: `{ "label": "your-app" }`. The response returns the raw key once, in `apiKey`. Store it safely; it cannot be recovered later.

### POST /tester/v1/intents/quote

Requests a sandbox quote. Required fields: `kind`, `inputAsset`, `inputAmount`, `outputAsset`, `outputChain`, `minOutputAmount`, `recipient`, `deadline`. Optional: `spendLimit`. The sandbox sets `userId` from your key, caps `inputAmount` at 10, and rejects NGN fiat payout requests. The response carries `quoteId`, `status` (`quoted` or `no_route`), `bids` and `bestBid`.

Intent kinds: `fare_payment`, `driver_payout`, `automatic_convert`, `manual_convert`, `swap_convert`, `cross_chain_payout`, `escrow_release`, `recurring_session`, `agent_payment`, `bulk_disbursement`, `anchor_off_ramp`, `anchor_on_ramp`.

### POST /tester/v1/intents/submit

Opens an intent from your quote. Body: `{ "quoteId": "...", "idempotencyKey": "..." }`. Submitting the same idempotency key twice returns the same intent. A quote issued to another key returns `quote not found`.

### GET /tester/v1/intents/:intentId

Returns your intent record: status, selected bid, balances, events and transaction hashes.

### POST /tester/v1/intents/:intentId/simulate-fill

Simulates solver fill and settlement for Stellar routes, ending in status `settled` with simulated transaction hashes. Cross-chain tester intents stop at `filled` until delivery proof verification, matching the production rule that a solver reference alone never settles.

### POST /tester/v1/intents/:intentId/refund

Refunds an open intent after its deadline has passed. Refunding before the deadline fails with `deadline has not passed`.

### POST /tester/v1/reset

Clears your sandbox quotes and intents. Other testers are unaffected.

## Intent lifecycle in the sandbox

`open` after submit, then `filled` and `settled` through simulate-fill, or `refunded` after the deadline. Terminal intents cannot change state again.

## Errors

Errors are plain messages. Common cases:

- `api key verification failed: invalid_key` or `sandbox_required`: use a sandbox key issued by POST /tester/v1/keys.
- `tester sandbox inputAmount exceeds cap 10`: lower the test amount.
- `tester sandbox does not support fiat payout`: NGN routes are production-gated and unavailable in the sandbox.
- `quote not found` / `intent not found`: the record belongs to another key, was reset, or does not exist.
- `rate limit exceeded`: wait for the current minute window to pass.
- `deadline has not passed`: refunds open only after the intent deadline.

## Limits that stay in force

- Testnet only. No mainnet settlement and no live fiat payout are available through the sandbox.
- Simulated settlement proves API behaviour, not production liquidity.
- Production use still requires the platform gates stated in `docs/oruva-stellar-intents.md`: custody validation, SEC/VASP legal clearance, partner approvals, independent penetration test and founder mainnet authorization.
