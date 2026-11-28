# Oruva Intents architecture

How Oruva Intents is built, layer by layer. The design follows the
intent pattern: the user states the desired outcome, solvers compete
to fill it, a verifier settles approved terms atomically, and funds
refund by deadline when conditions are not met. Everything here runs
on Stellar testnet in the sandbox today; mainnet stays behind the
custody, legal, partner and security gates in
[mainnet-switch.md](mainnet-switch.md).

## Layers

1. **Verifier ledger** (`backend/src/ledger.js`). Deposited assets
   are credited to accounts in one ledger. Signed intents move value
   between ledger accounts; withdrawals debit the ledger. The core
   intent type is `token_diff`: negative values are given, positive
   values are received, and settlement applies only when every asset
   nets to zero across parties and no balance goes negative. Payloads
   carry `signer_id`, `verifying_contract`, `deadline`, a 256-bit
   base64 `nonce` (single-use per signer, replay blocked) and the
   intent list. `transfer`, `add_public_key` and `remove_public_key`
   intents are supported alongside `token_diff`. On-chain, the
   Soroban escrow contract anchors settlement with solver bonds,
   slashing and dual-confirmation release.
2. **Solver relay** (`backend/src/relay.js`). Solvers register a
   quote function. A quote request fans out with a 3 second timeout
   and returns surviving options best-first. Batch publishing
   reports per-intent results so failed entries can be requoted.
   Relay statuses: `PENDING`, `TX_BROADCASTED`, `SETTLED`,
   `NOT_FOUND_OR_NOT_VALID`.
3. **Swap API** (`backend/src/swapApi.js`). The hosted layer apps
   integrate with:
   - `GET /tester/v1/tokens` lists supported assets. Asset IDs come
     from this catalog at integration time.
   - `POST /tester/v1/swap/quote` prices a swap. `dry: true`
     validates and prices without deposit instructions. Committed
     quotes return `depositAddress`, `depositMemo` (Stellar memo
     mode), `deadline`, `timeWhenInactive`, fee fields and a service
     `signature` over the quote.
   - Swap types: `EXACT_INPUT`, `EXACT_OUTPUT` (input buffered by
     slippage, `minAmountIn` included), `FLEX_INPUT`, and
     `ANY_INPUT` (partner authorization required).
   - Deposit types: `ORIGIN_CHAIN` (send to the deposit address
     with the memo) and `INTENTS` (funds already in the ledger,
     authorized by signed intent). Refund and recipient types mirror
     these locations.
   - `POST /tester/v1/swap/deposit/submit` reports a deposit;
     `GET /tester/v1/swap/status` polls `PENDING_DEPOSIT`,
     `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`,
     `INCOMPLETE_DEPOSIT`, `REFUNDED` or `FAILED`. Deposits below
     the minimum stay incomplete; unpaid swaps refund at deadline;
     excess input refunds after completion.
   - Signed execution: `POST /tester/v1/swap/generate-intent`
     returns the unsigned payload, the user signs it unchanged with
     SEP-53, and `POST /tester/v1/swap/submit-intent` verifies the
     signature, executes against the ledger and returns an
     `intentHash`.
   - Limit orders: `POST /tester/v1/swap/orders` rests a swap at a
     limit output, partial fills are allowed, cancel refunds the
     unfilled remainder. States: `AWAITING_DEPOSIT`, `OPEN`,
     `PARTIALLY_FILLED`, `FILLED`, `PENDING_CANCEL`, `CANCELED`,
     `EXPIRED`, `UNTRIGGERED`. Default deadline is 7 days, `GTC`.
   - Confidentiality: `public`, `basic` and `advanced` are
     accepted. On testnet, confidential routing is modelled through
     the signed-intent path and labelled as simulation; there is no
     private-shard settlement yet.

## Fees

Quotes itemize fees in basis points: protocol fee, platform fee
(20 bps standard, 1 bp for stablecoin and same-asset routes),
optional `appFees` distribution with a platform minimum, and an
optional insured flag at 2 bps. The quote returns the total fee
amount in the output asset. Sandbox refund and withdraw fees are 0.

## Accounts and keys

Registration issues a Master ID, Master Key (named after the
registered business, organization or platform) and the Master URL.
Optional sub-keys carry an ID Name, chosen scopes and a timer, and
can be deleted by ID Name at any time. Sandbox amounts cap at 10
whole units and fiat payout is rejected.

## Honest limits

- Settlement in the sandbox is simulated through the ledger with
  sandbox transaction markers; the Soroban contract evidence is
  testnet-only.
- Cross-chain delivery (CCTP) is testnet-proven for Stellar to
  Polygon USDC; other chains route through external providers only
  with live quotes, and NEAR 1Click remains an external route name.
- No mainnet, no live fiat payout and no custody claim until the
  gates in [mainnet-switch.md](mainnet-switch.md) clear.
