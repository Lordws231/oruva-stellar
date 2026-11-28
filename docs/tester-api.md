# Oruva Intents Tester API and Sandbox

The Tester API lets other developers use and test Oruva Intents on Stellar testnet. It is a sandbox: no real funds move, no mainnet path exists, and fiat payout is not supported. Public base: `https://intents.oruva.com.ng`. New here? Start with the five minute guide in `docs/developer-quickstart.md`.

## What a tester gets

- A self-issued sandbox API key (`oruva_test_...`), shown once at issuance and stored only as a hash.
- Capped test amounts: `inputAmount` up to 10 test units per intent.
- Per-key isolation: quotes, intents and idempotency keys belong to the issuing key only. Another key cannot see or act on your records.
- A simulated fill flow for same-chain Stellar intents, so a full quote, submit and settle cycle can be tested end to end.
- A reset endpoint that clears your own sandbox records.
- Rate limits: 60 requests per minute per key, and 5 key issuances per hour per label.

## Registration and master credentials

Access requires registration. `POST /tester/v1/register` with `businessName` (your registered business, organization or platform name), email and `acceptTerms: true` creates your account and issues your credentials: a Master ID (`oruva-dev-...`), your Master Key (shown once, stored hashed, named after your registered business name by default), and the Master URL `https://intents.oruva.com.ng/tester`. Oruva issues all three; you never invent them. `POST /tester/v1/signin` with your Master ID and Master Key signs you back in. The dashboard stays locked until you register or sign in.

## Authentication

Send your Master Key on every call except health, registration and sign-in:

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

### POST /tester/v1/account/keys

Creates an optional sub-key under your account, so apps never expose the Master Key. Master Key required. Body: `{ "idName": "my-app", "scopes": ["intents:quote", "intents:submit"], "expiresInMinutes": 60 }`. Every optional key carries an ID Name, unique in your account. Scopes are any subset of `intents:quote`, `intents:submit`, `intents:status`, `intents:refund`. The timer accepts `expiresInMinutes` (1 to 43200) or a future `expiresAt`; omit both for no expiry. The raw key returns once, in `apiKey`. Expired keys fail with `expired`.

### POST /tester/v1/account/keys/delete

Deletes an optional key by its ID Name: `{ "idName": "my-app" }`. Master Key required. Deletion has no conditions: active, expired and revoked optional keys can all be deleted, and the key stops working immediately.

### GET /tester/v1/account/keys

Lists your master and sub-keys with scopes, expiry and status. Master Key required.

### POST /tester/v1/account/keys/:keyId/revoke

Revokes a sub-key immediately. Master Key required. The Master Key itself cannot be revoked here.

### POST /tester/v1/keys

Legacy standalone sandbox key issuance. Prefer registration plus sub-keys for account-based testing.

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

### Swap API

The full swap layer is documented in [oruva-intents-architecture.md](oruva-intents-architecture.md). Endpoints: `GET /tester/v1/tokens` (public catalog), `POST /tester/v1/swap/quote` (dry or committed; swap types `EXACT_INPUT`, `EXACT_OUTPUT`, `FLEX_INPUT`, partner-gated `ANY_INPUT`; amounts are integer strings in the smallest unit), `POST /tester/v1/swap/deposit/submit`, `GET /tester/v1/swap/status?depositMemo=...`, `POST /tester/v1/swap/generate-intent`, `POST /tester/v1/swap/submit-intent` (SEP-53 signed ledger execution), `POST /tester/v1/swap/orders` plus fund, simulate-fill, cancel, get and list for limit orders, and `GET /tester/v1/swap/balances` for verifier ledger balances.

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
