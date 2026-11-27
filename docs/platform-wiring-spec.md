# Oruva platform wiring spec: Stellar escrow, CCTP bridge, payment rails

Date: 27 November 2026. Status: preparation spec for the platform wiring
build. The production Oruva platform does not call the Stellar escrow
yet; this spec is what the wiring build implements. Testnet evidence for
the contract and the bridge leg is in
`docs/dual-confirmation-evidence.md`.

## 1. Payment-rail architecture (founder decision, 27 November 2026)

Three rails, one internal ledger:

- **Paystack is the default fiat rail.** Rider NGN payments, driver and
  rider subaccounts on Tier 2 approval, split payments, and NGN
  withdrawals via Paystack Transfers.
- **Stellar is the crypto settlement rail.** USDC escrow lock, release,
  and refund, and driver crypto balances.
- **Flutterwave is only the crypto conversion end.** Stellar USDC to
  Circle CCTP to Base USDC to Flutterwave stablecoin wallet to NGN
  conversion. Flutterwave then sends an NGN bank transfer into the
  user's Paystack Dedicated Virtual Account (DVA). The user withdraws
  manually from the Oruva/Paystack balance to their personal bank
  account.
- **One visible account number per user.** Drivers and riders cannot
  have two account numbers in the Oruva app. The one visible Oruva
  account number is the user's Paystack DVA, with the Paystack
  subaccount and settlement identity behind it. The app never shows a
  separate Flutterwave account number.
- **Oruva's internal ledger is the joining layer.** Value is tracked in
  source-tagged sub-balances behind the one visible account.

### Source-tagged sub-balances (per user)

| Sub-balance | Meaning |
| --- | --- |
| `paystack_ngn_available` | NGN in the user's Paystack DVA balance, withdrawable manually via Paystack. Converted crypto earnings land here as a DVA credit tagged with their crypto source |
| `stellar_usdc_available` | USDC earnings released on Stellar, withdrawable as crypto or convertible |
| `pending_bridge` | USDC burned on Stellar, not yet credited at Flutterwave |
| `pending_payout` | Flutterwave NGN transfer into the Paystack DVA initiated, DVA credit not yet confirmed |

There is no user-visible Flutterwave balance. Converted NGN lands as a
Paystack DVA credit tagged with its crypto source, so the ledger keeps
the source trail without showing a second account.

Rules:

- Fiat NGN rides: Paystack collection and split settle to the user's
  Paystack side as already designed.
- Crypto rides: the Stellar escrow releases USDC. If the driver or
  rider chooses NGN, the bridge converts it and Flutterwave transfers
  the NGN into the user's Paystack DVA account number. The user then
  withdraws manually from the Oruva/Paystack balance to their personal
  bank account. Crypto kept as crypto withdraws via Stellar.
- Crypto itself never enters Paystack. Only converted NGN arrives, by
  bank transfer into the Paystack DVA.
- Checkout chooses the rail by payment method: an NGN ride settles on
  Paystack; a USDC ride settles through the Stellar escrow.
- Refunds return on the originating rail before conversion. After
  conversion, a refund is handled as an NGN payout reversal or
  adjustment with a full audit trail.
- Source tagging and reconciliation keep the full chain per payout:
  ride ID, Stellar burn hash, CCTP/Base mint hash, Flutterwave
  conversion reference, Flutterwave transfer reference, Paystack DVA
  credit reference, then the manual withdrawal reference.

### DVA blocker (stated plainly)

Paystack DVA enablement and naming confirmation was requested on
23 November 2026 (DVAs named ORUVA plus driver name) and Adebusola's
reply was still awaited. Dashboard checks have not verified DVA
receiving rules for this flow. Treat DVA receiving as unverified until
Paystack confirms enablement and receiving rules. If DVA receiving is
not enabled for this flow, that is a blocker for the converted-NGN
landing step: keep the ledger design ready and do not show users a
second account number as a workaround.

## 2. Escrow integration points

Contract: `contracts/oruva-escrow` (dual-confirmation instance on
testnet: `CBJSKJ3MROFMWYB2WRAMY237I7PQMIVLE2DMPC4DFDEBG23NYBQ7TUZP`).
One ride id maps to one escrow; ride ids are single-use on-chain.

| Platform event | Contract call | Caller and authorization |
| --- | --- | --- |
| Ride accepted (USDC ride) | `lock_fare(rider, driver, amount, ride_id)` | Rider wallet authorizes; pulls the fare into escrow |
| Trip completes, driver side | `confirm_arrival(driver, ride_id, proof_ref)` | Driver wallet authorizes; `proof_ref` is a hash or short proof string the platform derives from its location evidence |
| Trip completes, passenger side | `authorize_release(rider, ride_id)` | Rider wallet authorizes |
| Both confirmations present | `release_fare(ride_id)` | Any submitter (platform backend); credits the driver's withdrawable balance |
| Ride cancelled before completion | `refund_fare(ride_id)` | Admin (Oruva platform account) authorizes |
| Driver withdraws crypto | `withdraw(driver, destination, amount)` | Driver authorizes and submits; 90% to destination, 10% to treasury |
| Reads | `get_ride(ride_id)`, `get_driver_balance(driver)` | Read-only simulation |

Design notes:

- The contract stores the arrival proof reference; it does not verify
  GPS itself. The platform must derive `proof_ref` from its own location
  evidence (for example a hash of the trip-end location record) and keep
  the underlying evidence in the platform database for disputes.
- Release needs both confirmations. The admin cannot release alone.
  Refund stays admin-authorized for cancellations and disputes.
- `confirm_arrival` and `authorize_release` are retry-safe: repeating
  the same confirmation succeeds without changing state. A different
  proof after the first one is rejected (`ArrivalAlreadyConfirmed`).
- Amounts are i128 in the token's smallest unit (7 decimals for Stellar
  USDC). The platform converts fare amounts once, at quote time, and
  stores both the display amount and the smallest-unit amount.

### Wallet preflight checks (before every submission)

Run these checks before submitting, and surface failures as platform
errors, not raw chain errors:

1. Balance and budget: the source wallet holds enough USDC for the fare
   or withdrawal amount, and enough XLM for the transaction fee and any
   rent the invocation needs.
2. Trustline: the destination of a token transfer holds a trustline for
   the fare token (for withdrawals to external wallets, check before
   offering the withdrawal; the contract transfer fails without one).
3. Reserve: the account keeps its minimum XLM reserve after the fee;
   never submit a transaction that would take the account below reserve.
4. Fees: simulate first, read the resource fee from the simulation, and
   submit with that fee basis. On a fee-related failure, re-simulate and
   re-quote; do not blindly bump and resubmit the same payload.
5. State: read `get_ride` before release or refund so the platform acts
   on current on-chain state, not a stale local copy.

### Idempotent submission and status checks

- Every platform action gets a single-use operation ID stored before
  submission. The on-chain ride id is the idempotency key for escrow
  actions: a second `lock_fare` for the same ride id fails on-chain
  with `AlreadyExists`, so a retried submission cannot double-lock.
- Before any resubmission, check status: read `get_ride` (and
  `get_driver_balance` for withdrawals) and look up the previous
  transaction hash. Only resubmit when the chain shows the action did
  not land.
- `release_fare` on an already-released ride fails with `NotLocked`;
  treat that as "already done" after confirming status `Released`.
- Withdrawals are not naturally idempotent on-chain. Guard them with
  the payout ID (section 4): record the intended withdrawal, check the
  driver balance before and after, and never submit a second withdrawal
  for the same payout ID without a status check showing the first one
  did not land.

### Event indexing for settlement records

The contract emits `FareLocked`, `FareReleased`, `FareRefunded`,
`ArrivalConfirmed`, `ReleaseAuthorized`, and `DriverWithdrawal` events,
with the ride id or driver as a topic. Soroban RPC event retention is
short, so the platform must persist events into its own database:

- Poll or subscribe for contract events from a stored ledger cursor;
  advance the cursor only after the events are written.
- Store the full event payload with the ledger sequence, transaction
  hash, and contract id. Deduplicate on (transaction hash, event index).
- Reconcile gaps: if the cursor falls behind RPC retention, backfill
  from Horizon transaction history for the contract account and mark
  any unrecoverable gap for manual review instead of guessing.
- Settlement records, driver statements, and dispute evidence read from
  the persisted events, never from live RPC queries alone.

### Judge evidence logging fields

For every escrow action, log and keep:

- Ride ID and payout ID (where applicable).
- Contract ID and function called.
- Transaction hash and the Stellar Expert testnet link
  (`https://stellar.expert/explorer/testnet/tx/<hash>`).
- The contract event or receipt for the action.
- Balances before and after (rider, driver balance, treasury, external
  wallet where relevant).
- The arrival proof reference for releases, and the platform location
  evidence ID it was derived from.

## 3. CCTP bridge adapter (Stellar USDC to Flutterwave NGN)

The bridge converts a driver's Stellar USDC into NGN in the driver's
Paystack DVA balance. Route: Stellar USDC, Circle CCTP burn, Base USDC
mint into Oruva's Flutterwave stablecoin wallet, NGN conversion,
Flutterwave bank transfer into the user's Paystack DVA account number.
Destination domain: Base = 6. Source domain: Stellar = 27.

### Adapter boundary

The platform calls one bridge adapter with a payout ID, a USDC amount,
and the user's Paystack DVA account number as the NGN destination. The
adapter owns:

- The Stellar burn (wrapper flow below).
- Attestation polling and forward tracking.
- Flutterwave credit verification, conversion, and bank transfer.
- The payout record (section 4) and the state machine (below).

Nothing outside the adapter talks to Circle or Flutterwave directly.
The mint recipient is Oruva's Flutterwave Base USDC wallet address, a
configuration value confirmed from the Flutterwave dashboard. It is not
confirmed yet; never hardcode or invent an address.

### Stellar wrapper flow (one authorization)

CCTP on Stellar pulls USDC with `transfer_from`, so a burn needs an
allowance. The production flow uses a wrapper contract so one user
authorization covers both steps in a single invocation:

1. Wrapper calls USDC `approve` for the TokenMessengerMinter, amount
   equal to the burn amount, with a short expiration ledger.
2. Wrapper calls `deposit_for_burn_with_hook` on the
   TokenMessengerMinter with:
   - `amount`: burn amount in Stellar 7-decimal units (CCTP takes the
     first 6 decimals; keep amounts at 6-decimal precision).
   - `destination_domain`: 6 (Base).
   - `mint_recipient`: the Flutterwave Base USDC wallet address,
     left-padded to 32 bytes.
   - `burn_token`: the USDC Stellar Asset Contract.
   - `destination_caller`: 32 zero bytes (the Forwarding Service does
     not work when a destination caller is set).
   - `max_fee`: precise fee from the quote (below), no large buffer;
     excess max_fee is not refunded.
   - `min_finality_threshold`: 2000.
   - `hook_data`: the 32-byte version 0 forwarding hook,
     `0x636374702d666f72776172640000000000000000000000000000000000000000`,
     so Circle submits the Base mint and no Base gas wallet is needed.

The testnet proof in `docs/dual-confirmation-evidence.md` used the
two-transaction equivalent (separate approve, then burn). The wrapper
contract is part of the wiring build; the burn parameters are identical.

### Conversion trigger, rate and credit

Drivers and users choose either Automatic Convert or manually tap
Convert for USDC. When conversion runs, Flutterwave converts USDC to
NGN and automatically initiates the NGN payment into the user's
Oruva sub-account side (the single Paystack DVA destination above; no
second account number is shown in the app).

- Oruva displayed conversion rate = Flutterwave USDC/NGN rate reduced
  by 15%. Formula: `displayed_rate = flutterwave_rate * 0.85`.
- Credit formula:
  `ngn_credit = usdc_amount * displayed_rate - flutterwave_crypto_conversion_fee`.
- Worked example: if the Flutterwave rate is 1,400 NGN per 1 USDC,
  the displayed rate is 1,190 NGN/USDC. For 200 USDC, gross is
  238,000 NGN, then subtract the Flutterwave crypto conversion fee
  quoted at conversion time.
- Before a manual conversion, show the user the displayed rate, USDC
  amount, gross NGN, Flutterwave conversion fee and final NGN credit.
  For Automatic Convert, use the same calculation at conversion time
  and record the quote, rate and fee in the payout trail.
- Do not hardcode the Flutterwave fee percentage unless Flutterwave
  confirms it for stablecoin-to-NGN conversion; use the live quote or
  fee returned for the conversion.

### Fee quote and attestation

- Quote: `GET /v2/burn/USDC/fees/27/6?forward=true`. Use the
  `finalityThreshold` 2000 entry. `minimumFee` is the protocol fee in
  basis points; `forwardFee` is in 6-decimal USDC units. Set `max_fee`
  to protocol fee plus `forwardFee` converted to Stellar 7-decimal
  units (multiply by 10). Quote at payout creation and store the quote
  with an expiry; re-quote only before the burn, never after.
- Attestation: poll `GET /v2/messages/27?transactionHash=<stellar hash>`
  until status complete, then keep polling until `forwardState` is
  CONFIRMED and `forwardTxHash` is present. Record both.
- After the forward confirms, verify the Flutterwave credit by API or
  status lookup against the Base mint hash and wallet address before
  converting. Convert USDC to NGN, then Flutterwave sends an NGN bank
  transfer into the user's Paystack DVA account number. Verify the DVA
  credit before marking the payout complete. The user withdraws
  manually from the Oruva/Paystack balance to their personal bank
  account; that manual withdrawal is a separate Paystack step with its
  own reference.

### Payout state machine

States: `quoted`, `burned`, `attesting`, `minted`, `credited`,
`converted`, `paid`, `failed-reconcile`.

- `quoted`: payout created, CCTP fee quote and conversion quote stored
  with expiry (Flutterwave rate, displayed rate at 85%, gross NGN,
  Flutterwave conversion fee and final NGN credit). The amount sits in
  `stellar_usdc_available` until the burn. Automatic Convert creates
  this quote at conversion time; manual Convert shows it to the user
  before they confirm.
- `burned`: Stellar burn transaction confirmed. Move the amount to
  `pending_bridge`. Never re-burn after a successful burn.
- `attesting`: attestation or forward still pending. Resume polling;
  do not resubmit anything.
- `minted`: Base mint confirmed (`forwardTxHash` recorded).
- `credited`: Flutterwave stablecoin wallet credit verified.
- `converted`: NGN conversion confirmed; move the amount to
  `pending_payout` when the transfer into the user's Paystack DVA is
  initiated.
- `paid`: the NGN credit is confirmed in the user's Paystack DVA,
  tagged with its crypto source in `paystack_ngn_available`. The user's
  manual withdrawal to their personal bank account follows as a
  separate Paystack withdrawal with its own reference.
- `failed-reconcile`: any step failed or is ambiguous. Freeze the
  payout, reconcile by burn hash, mint hash, and Flutterwave references,
  and only then decide. If the Flutterwave credit is not seen, do not
  re-burn; reconcile by Base mint hash and wallet address first.

Single-use payout IDs, status checks before any resubmission, no blind
retries. A resume always starts from the recorded state and hashes.

### Fallbacks

- If CCTP forwarding is unavailable for the route: ROZO or NEAR Intents
  intent routing from Stellar to Base.
- Oruva inventory conversion (treasury receives Stellar USDC and
  releases Base USDC from its own float) is an emergency fallback only,
  not the primary design. It adds custody, liquidity, and compliance
  burden.

### Live-status labelling

Live Flutterwave NGN payout is pending stablecoin approval, IP
whitelist, wallet-address confirmation, compliance review, and a
small-value live test. Until those gates clear, every surface (app,
docs, submission pack) labels the Flutterwave leg as integration in
progress. Do not claim live NGN payout anywhere.

## 4. Payout records and reconciliation

Every payout has one idempotent payout ID linking:

- Ride ID and source rail (Paystack, Stellar, or Flutterwave-converted).
- Transaction hashes and references: Stellar burn hash, Base
  mint/forward hash, Flutterwave credit reference, Flutterwave
  conversion reference, Flutterwave transfer reference, Paystack DVA
  credit reference, then the manual withdrawal reference (and Paystack
  references for fiat payouts).
- Fees at each step and the FX quote used.
- Final bank status.

Daily reconciliation across four sources: Paystack settlements, Stellar
contract events, CCTP burn and mint records, and Flutterwave conversion
and transfer records. Reconciliation compares the internal ledger
sub-balances against each source, flags breaks by payout ID, and never
auto-adjusts money movement; breaks go to `failed-reconcile` handling
with an audit trail.

## 5. Platform-side adapter boundary (summary)

- `EscrowAdapter`: lock, confirm arrival, authorize, release, refund,
  withdraw, reads, event indexing. Owns preflight checks and idempotent
  submission for escrow actions.
- `BridgeAdapter`: CCTP quote, wrapper burn, attestation polling,
  Flutterwave credit, conversion, NGN transfer into the user's Paystack
  DVA, payout state machine.
- `LedgerService`: source-tagged sub-balances, payout IDs, daily
  reconciliation, audit trail.
- `PaystackAdapter`: unchanged fiat rail (payments, subaccounts,
  splits, Transfers). It never receives crypto value.

The simulated Flutterwave conversion adapter in `backend/` stays the
test double until the live gates in section 3 clear; the wiring build
replaces it behind the same `BridgeAdapter` boundary.
