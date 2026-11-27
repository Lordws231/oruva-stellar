# Oruva Stellar Intents

Status: testnet MVP, built and verified Nov 27, 2026. No mainnet
deployment. No live fiat payout is claimed.

Oruva Stellar Intents is Oruva's Stellar-native intents service,
modelled on the intent pattern behind NEAR Intents and 1Click, but
settled on Stellar. It is a public developer platform: other builders
can use it in their own products through an API and SDK. Mobility fare
and driver payout intents are Oruva's first vertical, not the limit.

## What is built

- Soroban contract `contracts/oruva-intents`: intent escrow and
  verifier. A user locks an input asset with a single-use intent hash,
  a minimum output amount, output asset, output chain and recipient
  binding, a deadline ledger and an intent kind. A registered solver
  fills the intent by delivering at least the minimum output to the
  bound recipient; settlement releases the locked input to the solver
  and records the fill evidence. After the deadline an unsettled
  intent refunds to the user. The user can cancel before any fill.
  Fare payment intents require the driver's arrival proof plus
  passenger authorization before settlement, reusing the oruva-escrow
  dual-confirmation pattern. Solver registration records a bond
  amount; penalties are recorded and emitted. Bond escrow and
  slashing economics are later scope.
- Backend skeleton `backend/src/intents.js`: quote requests, solver
  bids, best-fill selection, idempotent submission, status tracking,
  refund path, evidence packs, API-key rate limiting, webhook event
  building, and route adapters. Route adapters: Stellar DEX and path
  payments (simulated quote), CCTP Stellar to Polygon, NEAR Intents
  1Click as an external route that is shown only with a live quote
  for the exact pair and amount, and a Flutterwave and anchor NGN
  route that stays unavailable in quotes until its gates clear.
- Public API contracts: quote, submit, status and refund handlers
  behind API keys with rate limits and idempotency keys. A TypeScript
  SDK, developer dashboard, webhooks delivery service and testnet
  sandbox keys are the next platform phase.

## Intent kinds

Mobility first: fare payment, driver payout, automatic convert,
manual convert. Generic developer platform kinds: swap and convert,
cross-chain payout, escrow release, recurring and session payments,
agent payments with spend limits, bulk disbursement, anchor off-ramp
and anchor on-ramp.

## Settlement routes

Stellar DEX and path payments for Stellar assets. CCTP for native
USDC from Stellar to Polygon. NEAR Intents 1Click as an external
solver route for Litecoin, XRP and other chains, only with a live
quote. Anchors and Flutterwave for fiat payout where licensed and
approved. Cross-chain fills in this MVP are solver attested: the
solver records an evidence reference such as a CCTP mint hash or a
1Click delivery reference, and the contract enforces amount,
recipient binding, deadline and single use. Production cross-chain
settlement needs delivery proof verification.

## Signed intents

Contract calls use Soroban authorization entries. The production
signing path adds SEP-53 message signing for off-chain intent
payloads and fee-bump sponsorship so users are not blocked by XLM
fees where policy allows. Agent-ready scope later: MPP and x402
style charge and session intents, scoped session keys, and on-chain
spend limits. The backend already enforces a spend limit at quote
time for agent payments.

## Solver model

Oruva is the first solver. Later, approved external solvers register
with bonds, fill-rate scoring and penalties for failed fills. Fees
and spread are shown in the quote. Business hooks: a platform fee on
filled intents, solver spread, and premium API tiers later.

## Safety and compliance

Wallet preflight checks cover trustline, reserve, fees and budget
before submission. Submission is idempotent and single-use; status
is checked before any resubmit, so retries cannot double-pay.
Tiered KYC by volume, sanctions and fraud screening hooks,
per-developer limits, audit logs and an evidence pack per intent
(tx hashes, events, balances, quote evidence) are part of the
platform design. Live fiat payout stays off until partner and
licensing gates clear: Flutterwave stablecoin approval, wallet
confirmation, compliance review, Paystack DVA receiving confirmation
and a small-value live test.

## Testnet evidence

Contract: CATN2TJES5JRVI4723HIL736TFFUE3Z7FSWZCU3GW64VSZIDCJZADO4N
was superseded during the demo by the fresh instance below.

Contract: CAATEONW5TQYLUQEZMH3EQLXCK5QER34TWUWWVCMKKO6MKJ6M37LEZUQ
Explorer: https://stellar.expert/explorer/testnet/contract/CAATEONW5TQYLUQEZMH3EQLXCK5QER34TWUWWVCMKKO6MKJ6M37LEZUQ

- Deploy: b1df8e7742d904d5bcca0b6734e812c46fe8f4e47cb52b326e5201082e109dbe
- Init: 6c96d604f08dac15c4fcd54f7814468c2f7370e1db4a0cca4da0230513553642
- Register solver: de3f89ed5718aa223443112a5128f9e7c6f9be1e41b68fc31a5a001fdc9562ed
- Create intent-001 (0.3 USDC locked): 0d479f2032671f2608ed0654383171e9f5b3cdf48fb5ca044dc45c57dceaf20a
- Fill and settle intent-001 (0.28 USDC delivered): e718227be74c121f22640ea91e6b4bd8736712ebe3b48b416adc7864c3929933
- Create intent-002 (0.05 USDC locked): 183cfe41e1904e60c3f4400131f31ecaf6450c6df9256e5e3f5ce63e58c5ec24
- Refund intent-002 after deadline: 634d6d2fc06c6cc11b33b593dfc1bf08cfaf1d20d565669d8e88816f52e46cb7

On-chain reads confirm intent-001 status Settled and intent-002
status Refunded. Demo script: scripts/intents-demo.sh.

Tests: contract host tests 14 passed. Backend tests 16 passed
(8 existing plus 8 intents tests).

## Remaining gaps

Platform wiring into the Oruva platform (EscrowAdapter calls,
event indexing, judge evidence fields) follows after build 0405.
The TypeScript SDK, developer dashboard, webhook delivery, solver
bond escrow and slashing, production cross-chain delivery proof
verification, and live fiat payout remain later phases behind their
gates.
