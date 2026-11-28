# Stellar Intents Developer Quickstart

Five minutes from zero to a settled testnet intent in the sandbox. Everything here is testnet and simulated: no real funds move.

## 1. Get a sandbox key

```sh
curl -X POST "$BASE/tester/v1/keys" -H 'content-type: application/json' \
  -d '{"label":"my-app"}'
```

Save the returned `apiKey`. It starts with `oruva_test_` and is shown once.

## 2. Request a quote

```sh
curl -X POST "$BASE/tester/v1/intents/quote" \
  -H 'content-type: application/json' -H "x-api-key: $TESTER_KEY" \
  -d '{"kind":"swap_convert","inputAsset":"USDC","inputAmount":5,"outputAsset":"USDC","outputChain":"stellar","minOutputAmount":4,"recipient":"G...","deadline":"2026-12-01T00:00:00.000Z"}'
```

Sandbox cap: `inputAmount` up to 10. Use the returned `quoteId` next.

## 3. Submit, settle, check status

```sh
curl -X POST "$BASE/tester/v1/intents/submit" \
  -H 'content-type: application/json' -H "x-api-key: $TESTER_KEY" \
  -d '{"quoteId":"<quoteId>","idempotencyKey":"run-1"}'

curl -X POST "$BASE/tester/v1/intents/<intentId>/simulate-fill" \
  -H "x-api-key: $TESTER_KEY"

curl "$BASE/tester/v1/intents/<intentId>" -H "x-api-key: $TESTER_KEY"
```

The intent ends `settled` with simulated transaction hashes. To test refunds, submit with a deadline in the past and call `POST /tester/v1/intents/<intentId>/refund`.

## 4. Or use the TypeScript SDK

```ts
import { createTesterClient } from '@oruva/stellar-intents-sdk';

const client = createTesterClient({ baseUrl: BASE, apiKey: TESTER_KEY });
const quote = await client.quote({
  kind: 'swap_convert',
  userId: 'ignored-in-sandbox',
  inputAsset: 'USDC',
  inputAmount: 5,
  outputAsset: 'USDC',
  outputChain: 'stellar',
  minOutputAmount: 4,
  recipient: 'G...',
  deadline: '2026-12-01T00:00:00.000Z',
});
const intent = await client.submit({ quoteId: quote.quoteId });
await client.simulateFill(intent.intentId);
const status = await client.status(intent.intentId);
```

## 5. Try the dashboard

Open `dashboard/index.html`, set the API base to your tester host plus `/tester`, paste your sandbox key, and run quote, submit, status and refund from the browser. The key stays in page memory only. Read the full reference in `dashboard/docs.html` or `docs/tester-api.md`.

## Testnet evidence

The sandbox mirrors the on-chain testnet build. Bond escrow instance: `CAXOQEOG2UVT5DJZF76NMBIZRPPVIQOKPQTBP67OTYMV2MGED7AMJU6X` on Stellar testnet, with settle, refund and slash transactions recorded in `docs/oruva-stellar-intents.md`.

## Going further

- Full endpoint reference and errors: `docs/tester-api.md`
- Platform design, routes and production gates: `docs/oruva-stellar-intents.md`
- Reset your sandbox any time with `POST /tester/v1/reset`.
