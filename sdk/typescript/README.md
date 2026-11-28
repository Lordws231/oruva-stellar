# Oruva Intents TypeScript SDK

Client for the Oruva Intents testnet API contracts: quote, submit, status and
refund. This phase covers testnet and simulated or quote gated routes only. It does not
claim live fiat payout.

## Usage

```ts
import { OruvaStellarIntentsClient } from './src/index.ts';

const client = new OruvaStellarIntentsClient({
  baseUrl: 'https://api.example.test',
  apiKey: '<testnet sandbox api key>',
});

const quote = await client.quote({
  kind: 'swap_convert',
  userId: 'dev-user-1',
  inputAsset: 'USDC',
  inputAmount: 100,
  outputAsset: 'USDC',
  outputChain: 'stellar',
  minOutputAmount: 95,
  recipient: 'GRECIPIENT',
  deadline: '2026-12-01T00:00:00.000Z',
});

const intent = await client.submit({ quoteId: quote.quoteId });
const status = await client.status(intent.intentId);
```

The client sends the API key in the `x-api-key` header and generates an idempotency key
for submit calls unless the caller provides one. Non 2xx responses throw `OruvaApiError`
with the HTTP status and parsed body.

## Scripts

- `npm test` runs the Node test suite in `test/`. Node 24 strips TypeScript types at
  runtime, so the tests import `src/index.ts` directly with no build step.
- `npm run check` runs `node --check` on `src/index.ts` and `test/client.test.mjs`.
  This catches syntax errors offline. It does not typecheck: type errors that the
  TypeScript compiler would reject can still pass this check.

## Why tsc does not run offline here

The TypeScript compiler is not available in this workspace without a network install:

- This package declares no dependencies and has no `node_modules` directory, so there
  is no local `typescript` install for `tsc` to run from.
- `tsc` is not on the PATH and no global TypeScript install exists.
- `npx --no-install tsc --version` exits with an error from the placeholder `tsc`
  package, which is not the TypeScript compiler.
- `npx --no-install -p typescript tsc --version` is canceled because the `typescript`
  package is missing. Running it without `--no-install` would download the compiler
  from the network, which this offline setup does not allow.

`tsconfig.json` is ready for the compiler: strict mode, NodeNext modules, declarations
and a `dist` output directory. When a network install is allowed, add TypeScript as a
dev dependency and run `tsc -p tsconfig.json` to build or `tsc -p tsconfig.json --noEmit`
to typecheck. Until then, `npm run check` plus `npm test` are the offline gates, with
the typechecking limit stated above.
