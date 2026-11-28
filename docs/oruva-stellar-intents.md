# Oruva Stellar Intents

Status: testnet MVP built and verified Nov 27, 2026; code gaps
finished and verified Nov 28, 2026 (solver bond escrow and slashing,
SEP-53 signing and fee-bump sponsorship, cross-chain delivery proof
verification, sandbox API keys and developer dashboard). No mainnet
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
  dual-confirmation pattern. Solver registration locks a bond in a
  per-solver bond asset, transferred into the contract. Solvers claim
  intents to record open obligations. A recorded penalty slashes the
  bond to the admin treasury sink, tracks any shortfall as penalty
  debt, and releases a claimed intent. Bond withdrawal returns the
  full remaining bond and ends registration, and is blocked during
  the 1000-ledger cooldown, while open obligations exist, or while
  penalty debt is outstanding. A top-up pays penalty debt first.
- Backend skeleton `backend/src/intents.js`: quote requests, solver
  bids, best-fill selection, idempotent submission, status tracking,
  refund path, evidence packs, API-key rate limiting, webhook event
  building, and route adapters. Route adapters: Stellar DEX and path
  payments (simulated quote), CCTP Stellar to Polygon, NEAR Intents
  1Click as an external route that is shown only with a live quote
  for the exact pair and amount, and a Flutterwave and anchor NGN
  route that stays unavailable in quotes until its gates clear.
- CCTP bridge adapter `backend/src/cctpBridge.js`: fee quote shape
  for Stellar domain 27 to Polygon domain 7, burn submission state,
  attestation polling state, mint completion state, idempotent payout
  IDs, and reconciliation records linking ride ID, burn hash, mint
  hash, conversion reference and final credit reference. Transport is
  injected; tests use simulated responses and submit no live burn.
- NEAR Intents 1Click client `backend/src/nearOneClick.js`: injected
  transport, live-quote guardrail, quote recording with deposit
  address, source transaction, solver delivery transaction, fees,
  slippage or minimum-out and refund path. XRPL asset care is
  enforced: XRP native and trustline stablecoins only, never USDT as
  native on XRPL.
- Webhook delivery queue `backend/src/webhooks.js`: HMAC signed
  payloads from an injected secret provider, retry with backoff
  state, and delivery status tracking. Tests run offline.
- Public API contracts: quote, submit, status and refund handlers
  behind API keys with rate limits and idempotency keys. A TypeScript
  SDK skeleton lives in `sdk/typescript` with API key headers,
  idempotency key generation and typed errors.
- SEP-53 signing `backend/src/sep53.js`: canonical intent payloads,
  SEP-53 hashing and Ed25519 sign and verify helpers with injected
  signers, including Stellar public key decoding. Fee-bump
  sponsorship `backend/src/feeBump.js`: envelope request building
  with sponsor and fee cap checks and injected signing and transport.
- Delivery proof verification `backend/src/deliveryProof.js`: CCTP
  message and attestation structure checks with domain, nonce,
  sender, recipient and amount binding, plus NEAR 1Click delivery
  status verification through injected transport. Cross-chain
  settlement in the backend requires a bound verified proof; a
  solver reference alone no longer settles.
- Sandbox API keys `backend/src/apiKeys.js`: issuance with 256-bit
  randomness, hash-only storage, scopes, revocation and sandbox mode
  checks. Developer dashboard `dashboard/index.html`: a static page
  that exercises quote, submit, status and refund against a
  configurable API base, with the key held only in page memory.

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
approved. Cross-chain settlement evidence passes the backend delivery
proof verification layer before settlement: CCTP evidence binds the
verified message fields and mint record to the intent, and 1Click
evidence requires a completed delivery status with matching amount,
recipient and quote reference. The contract enforces amount,
recipient binding, deadline and single use. The offline layer checks
attestation presence, format and field binding; Circle attester
signature recovery against production attester keys is a production
hardening step and is not claimed here.

## Signed intents

Contract calls use Soroban authorization entries. The backend
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

Tests at the MVP commit: contract host tests 14 passed, backend
tests 16 passed.

### Bond escrow instance, Nov 28, 2026

Contract: CAXOQEOG2UVT5DJZF76NMBIZRPPVIQOKPQTBP67OTYMV2MGED7AMJU6X
Explorer: https://stellar.expert/explorer/testnet/contract/CAXOQEOG2UVT5DJZF76NMBIZRPPVIQOKPQTBP67OTYMV2MGED7AMJU6X

- Deploy: dfa0c3634b0d4ed670859aea0d58fdffa2bccfc8138717aeb2c94485acd10530
- Init: 3d0dbe5770491c297b16ce21af7c7ff64637e95599fcdf506a5e077f78c539e5
- Register solver with 1 USDC bond locked: 199779b034f1a4fb54a515cafffb79c24c2513b63e9a9051236c461d6439c5a3
- Create intent-001 (0.3 USDC locked): 7b961b045835a6793d6b80d0020dbe36fd0f0fb55f6887c7a7925af109293ce0
- Claim intent-001: bef428ffcf769684dff74b220e5fc1bbe9a7adccfaf6f3d75fd3b21e93ec0aa9
- Fill and settle intent-001 (0.28 USDC delivered): dd0ad2887579ad3bfdfa820e4fa75967698e28579075ce02423e3003e3a47185
- Create intent-002 (0.05 USDC locked): 353725da0ecffa5a355f6802b4faede63bed036ccb90c479a66e103e5aa0db2f
- Refund intent-002 after deadline: 67e5a8e1c3fb6da6e39d355a1c4fb165813cb1129be2b735c625a5b7e9b0be50
- Slash solver bond by 0.2 USDC: 2b73c293ee0cd9b0a983d7d33d3d009b4c4865c962a6ad1544418037d6fa7534

On-chain reads confirm intent-001 status Settled, intent-002
status Refunded, and the solver bond reduced from 10000000 to
8000000 smallest units with one penalty recorded.

Tests Nov 28, 2026: contract host tests 21 passed, backend tests
53 passed, SDK tests 2 passed with the offline syntax check green.

## Tester API and sandbox

Other developers can use and test Stellar Intents on testnet through
the Tester API: self-issued sandbox keys, capped test amounts,
per-key isolation, simulated fills and a sandbox reset. No real
funds move and live keys are rejected. See `docs/tester-api.md`.

## Remaining gaps

The code items are finished. What remains is external gates, stated
plainly: no mainnet deployment, custody validation before any
mainnet value, SEC/VASP legal clearance, Flutterwave stablecoin
approval, Paystack DVA receiving confirmation, an independent
penetration test, and founder mainnet authorization. Live fiat
payout stays off until partner and licensing gates clear. Circle
attester signature recovery against production attester keys is a
production hardening step for the delivery proof layer.
