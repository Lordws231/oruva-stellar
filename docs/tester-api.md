# Oruva Stellar Intents Tester API and Sandbox

The Tester API lets other developers use and test Oruva Stellar Intents on Stellar testnet. It is a sandbox: no real funds move, no mainnet path exists, and fiat payout is not supported.

## What a tester gets

- A self-issued sandbox API key (`oruva_test_...`), shown once at issuance and stored only as a hash.
- Capped test amounts: `inputAmount` up to 10 test units per intent.
- Per-key isolation: quotes, intents and idempotency keys belong to the issuing key only.
- A simulated fill flow for same-chain Stellar intents, so a full quote, submit and settle cycle can be tested end to end.
- A reset endpoint that clears the tester's own sandbox records.

## Endpoints

- `GET /tester/v1/health` returns network, mode, caps and routes.
- `POST /tester/v1/keys` with `{ "label": "your-app" }` issues a sandbox key.
- `POST /tester/v1/intents/quote` with the `x-api-key` header returns a sandbox quote.
- `POST /tester/v1/intents/submit` with `{ "quoteId": "...", "idempotencyKey": "..." }` opens the intent.
- `GET /tester/v1/intents/:intentId` returns status.
- `POST /tester/v1/intents/:intentId/simulate-fill` simulates solver fill and settlement for Stellar routes. Cross-chain tester intents stay filled until delivery proof verification.
- `POST /tester/v1/intents/:intentId/refund` refunds after the deadline passes.
- `POST /tester/v1/reset` clears the caller's sandbox records.

## Quick start

```sh
curl -X POST "$BASE/tester/v1/keys" -H 'content-type: application/json' \
  -d '{"label":"my-app"}'

curl -X POST "$BASE/tester/v1/intents/quote" \
  -H 'content-type: application/json' -H "x-api-key: $TESTER_KEY" \
  -d '{"kind":"swap_convert","inputAsset":"USDC","inputAmount":5,"outputAsset":"USDC","outputChain":"stellar","minOutputAmount":4,"recipient":"G...","deadline":"2026-12-01T00:00:00.000Z"}'
```

With the TypeScript SDK, `createTesterClient({ baseUrl, apiKey })` points the client at the tester routes and adds `simulateFill` and `resetSandbox`.

## Limits that stay in force

- Testnet only. Live keys are rejected by the tester surface.
- No live fiat payout and no mainnet settlement are available through the sandbox.
- Production use still requires the platform gates stated in `docs/oruva-stellar-intents.md`: custody validation, SEC/VASP legal clearance, partner approvals, independent penetration test and founder mainnet authorization.
