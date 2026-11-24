# Oruva Stellar Settlement Rails

Fare settlement for Oruva Transportation Services, built for the Stellar
Buildathon (Build Week 25-30 November 2026, submission 1 December 2026).

**Testnet only. No real funds. Nothing here touches mainnet.**

## What it is

When a rider books a ride, the fare is locked in a Soroban escrow contract.
When the trip completes, the fare is released to the driver. When the ride is
cancelled, the fare is refunded to the rider. Every step emits an on-chain
event the Oruva platform can index.

- **Fare token:** in the live design, fares move in USDC on Stellar. The
  testnet demo uses **TUSD**, a test-issued asset that stands in for USDC
  (see "Why TUSD, not testnet USDC" below). The escrow contract is
  token-agnostic: swapping the fare token is a deployment configuration
  change, not a code change.
- **ORVA:** the Oruva reward token, issued on Stellar testnet as
  `ORVA:GBMC7N2HJSNHLPN2NIKTTUI2ZYJ6FFRN6IVTTTRARGRA4TZ7YHL45FOD`.
  Rewards and referral bonuses are a separate flow from fare settlement and
  are not part of this contract yet.

## Architecture

```text
Rider ──lock_fare──▶ oruva-escrow ──release_fare──▶ Driver
  (TUSD)              (holds fare)     (admin confirms
  ▲                                    trip completion)
  └──refund_fare── (admin confirms cancellation)
```

- `contracts/oruva-escrow` — the Soroban contract (Rust, soroban-sdk 29).
  - `init(admin, token)` — one-time setup; admin is the Oruva platform.
  - `lock_fare(rider, driver, amount, ride_id)` — rider authorizes; pulls
    the fare into escrow; ride becomes `Locked`. One ride id, one escrow.
  - `release_fare(ride_id)` — admin only; pays the driver; `Released`.
  - `refund_fare(ride_id)` — admin only; refunds the rider; `Refunded`.
  - `get_ride(ride_id)` — read-only ride state.
  - Events: `FareLocked`, `FareReleased`, `FareRefunded` (ride id is a
    topic, so rides are filterable).
- `tools/rpc-proxy.py` — local reverse proxy for the Stellar testnet RPC.
  Needed on this VM because it has no direct internet egress: outbound
  traffic must go through the egress proxy in `HTTPS_PROXY`, which the
  Stellar CLI's HTTP client ignores. The proxy listens on 127.0.0.1:8765
  and forwards to `https://soroban-testnet.stellar.org/` via curl.
- `scripts/demo.sh` — the end-to-end demo (see below).
- `deployed-contract.txt` — the deployed escrow contract id.
- `.env` — **gitignored.** Holds the three testnet account secret keys.
  Never commit it, never share it.

## Testnet deployment (verified 24 November 2026)

| Item | Address / hash |
| --- | --- |
| Issuer / admin (Oruva) | `GBMC7N2HJSNHLPN2NIKTTUI2ZYJ6FFRN6IVTTTRARGRA4TZ7YHL45FOD` |
| Rider | `GBXDYEVHLKQG4NRXZEPJQPGFJZFAFYHIBPXFDPU5SXAQE4PVCI5536CG` |
| Driver | `GDQ6K32UFR5WETDXLGJUA4YMCKC3U7H3YK5FD63TNDDF7UL6S436O6YH` |
| ORVA asset | `ORVA:GBMC7N2HJSNHLPN2NIKTTUI2ZYJ6FFRN6IVTTTRARGRA4TZ7YHL45FOD` |
| TUSD asset (USDC stand-in) | `TUSD:GBMC7N2HJSNHLPN2NIKTTUI2ZYJ6FFRN6IVTTTRARGRA4TZ7YHL45FOD` |
| TUSD Stellar Asset Contract | `CCV3MCX7LAZV27PHTNJ2SGLGZ3XG2VCSP7BKUG7PSX35IHYF35EJOCEJ` |
| oruva-escrow contract | `CBKN5SUUG6GV6XPX36RYZ4ABNZOBU3SXAF4MQBYP32QXGA7YJ3DOJWLA` |

Stellar Expert (testnet): https://stellar.expert/explorer/testnet/contract/CBKN5SUUG6GV6XPX36RYZ4ABNZOBU3SXAF4MQBYP32QXGA7YJ3DOJWLA

### Transactions (all confirmed successful on testnet)

Friendbot funding (10,000 XLM each):

- Issuer: `96c31b2366e17e4daeaa834be1b5bb0ac9aea1d4ae9a14ae6b811143572a0f32`
- Rider: `afbb279e44b5b7c5ac065f9ce9d589312acbb08ac46fc5a000dfba0863f56511`
- Driver: `97258c83f2d8a7504542ab53d66003dc7ed00f6839774df4f2aa7e96efcfb24a`

ORVA trustlines and issue (rider holds 1,000.0001 ORVA):

- Rider trustline: `9eba094916064b7ba94d4004ded056df4c8571a613b2cb6f10d7cfc4c28f5aa8`
- Driver trustline: `2acfe721ddceb833e9b2042b72f85bd7ca0edaadc9a48d23fe833dd038b75af7`
- Issue 1,000 ORVA to rider: `488980575e14636c4c7a597ffe5bb948c4c0ee8248af57c30843812e1c389101`

TUSD trustlines and issue (rider holds 475 TUSD after the demo):

- Rider trustline: `93979f82fda45d8e15fbd8057328efff132bfc96712d9f33b2cf7efa3a36612b`
- Driver trustline: `71a42884bd533cb94cc096ae152dbdeda584695a42c5190f743773c3b5df33e3`
- Issue 500 TUSD to rider: `19a9eb9a133f95e94e5e6e1ce50a04760eb1980725e8cdbcab5f5cef9a570614`
- Deploy TUSD Stellar Asset Contract: `13bde3aedb06db80f5c51c630c0113f5aa6343a166c5dadec26d3f36f73a8501`

Escrow deploy and init:

- Upload wasm: `ef215f70a238104a8522621889a4ca76793555a456fe955ba4b7694a64184550`
- Create contract: `c8e91cc6069273c275136ce54572dac9a3f5930854eb25fa3dc89a13fce5df8f`
- Init (admin = issuer, token = TUSD contract): `bf9def0f1ec0ab65e9cef597e24e593dbdb0b9f7d444abb14c2ce93002441ab5`

Demo, ride-001 (25 TUSD fare, completed):

- Lock fare: `45a705c606ab2e9bc4e63223b76d81c19eeb5a8e9b5e495732a4ea3345b819d1`
  ([Stellar Expert](https://stellar.expert/explorer/testnet/tx/45a705c606ab2e9bc4e63223b76d81c19eeb5a8e9b5e495732a4ea3345b819d1))
- Release fare to driver: `41a964c9fb5d195f6228bb797aaeb0d3fa01c725f17d7f8f078d7de3f6eb7375`
  ([Stellar Expert](https://stellar.expert/explorer/testnet/tx/41a964c9fb5d195f6228bb797aaeb0d3fa01c725f17d7f8f078d7de3f6eb7375))

Demo, ride-002 (10 TUSD fare, cancelled and refunded):

- Lock fare: `e72b4567de893c686fe485863f998d26b8434e56b4da2c677170525370c988b3`
- Refund fare to rider: `1e0a0c9d7780a2c1baf830d06add4c839dd7c413bf7e7dba78c1a9736bbc2c83`

Final demo balances: rider 475 TUSD, driver 25 TUSD.

## Setup

Prerequisites: Rust (1.84+; tested with 1.100.0), the Stellar CLI
(tested with 30.0.1), the `wasm32v1-none` target:

```sh
rustup target add wasm32v1-none
```

The Stellar CLI cannot reach the testnet RPC directly from this VM (no
direct egress; the CLI ignores the egress proxy). Start the local RPC proxy
first, in its own terminal:

```sh
python3 tools/rpc-proxy.py
```

Then export the RPC endpoint for every Stellar CLI command:

```sh
export STELLAR_RPC_URL=http://127.0.0.1:8765
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
```

Identities `issuer`, `rider`, `driver` live in the Stellar CLI key store
(`~/.config/stellar/identity/`); their secret keys are also in the
gitignored `.env` for reference. To recreate them from scratch, generate new
identities, fund via Friendbot, and re-run the setup steps in order:
trustlines, asset issue, SAC deploy, contract deploy, init.

## How to run the demo

```sh
python3 tools/rpc-proxy.py   # terminal 1, keep running
bash scripts/demo.sh         # terminal 2
```

The demo locks a 25 TUSD fare for `ride-001`, shows the ride `Locked`,
releases it on completion, shows the ride `Released`, and prints balances
before and after. Each ride id can only be used once; edit `RIDE_ID` in the
script (and fund the rider with more TUSD if needed) to run it again.

## Tests

```sh
cargo test -p oruva-escrow
```

9 tests, all passing (24 November 2026): lock moves funds and records the
ride (including the `FareLocked` event), release pays the driver, refund
returns the fare, double-lock rejected, release-after-refund rejected,
unknown ride rejected, zero amount rejected, double init rejected, unknown
ride reads as None.

## Build and deploy

```sh
stellar contract build
stellar contract deploy --wasm target/wasm32v1-none/release/oruva_escrow.wasm \
  --source-account issuer --alias oruva-escrow
stellar contract invoke --id oruva-escrow --source-account issuer -- \
  init --admin <issuer-address> --token <fare-token-contract-address>
```

The fare token's Stellar Asset Contract must be deployed first, or the
escrow's `transfer` calls fail with a missing-instance error:

```sh
stellar contract asset deploy --asset "TUSD:<issuer>" \
  --source-account issuer --alias tusd
```

## Gotchas found while building

- **The CLI ignores the egress proxy.** Direct egress from this VM is
  blocked; `stellar network health` fails with `client error (Connect)`.
  The local reverse proxy (`tools/rpc-proxy.py`) fixes it. Note the first
  version used Python urllib, which stalls on this proxy; the working
  version shells out to curl for the upstream leg.
- **`stellar tx new payment --amount` is in stroops**, not whole units.
  1,000 ORVA is `--amount 10000000000`. The same applies to
  `change-trust --limit`: a `--limit 1000000` trustline only holds 0.1 of
  the asset. Omit `--limit` for the maximum.
- **A Stellar Asset Contract must be deployed before use.** The derived
  address exists whether or not the contract does; invoking an undeployed
  SAC fails with `HostError: Error(Storage, MissingValue)`. Deploy it with
  `stellar contract asset deploy`.
- **Test events are per-invocation.** In unit tests,
  `env.events().all()` returns events from the last invocation only, so
  assert events before the next contract call.

## Why TUSD, not testnet USDC

No usable official testnet USDC could be obtained from this environment:
the Circle testnet issuer address on record is not a valid testnet issuer
(Horizon rejects it), the USDC assets that do exist on testnet are from
unverified issuers, and the Circle faucet is an interactive web form. TUSD
is issued by the Oruva testnet issuer account and is clearly labelled
everywhere as a stand-in. The escrow contract takes the fare token as a
constructor parameter, so pointing it at real USDC later needs no code
change.

## What is next

1. **Real USDC fare flow.** Get testnet USDC (Circle faucet, via the
   founder's browser) and re-init the escrow against the real USDC asset
   contract. Same contract, different token address.
2. **Off-ramp architecture.** The hard part of the build: a driver holding
   USDC needs naira in a bank account. The live SEP-24 NGN anchor (NGNC by
   Link.io) is effectively dormant, and global ramps (MoneyGram, $5 floor)
   do not serve Nigeria well. Options to evaluate during Build Week: a
   local anchor partnership, or an Oruva-operated off-ramp where Oruva
   buys drivers' USDC for naira via its Paystack rails.
3. **Platform wiring.** The Oruva platform backend (Node) should call
   `lock_fare` on ride acceptance, `release_fare` on trip completion, and
   `refund_fare` on cancellation, and index the `FareLocked` /
   `FareReleased` / `FareRefunded` events for settlement records. Driver
   and rider Stellar addresses map to platform users.
4. **ORVA rewards.** A second flow that pays ORVA bonuses (referrals,
   completed-ride rewards) from Oruva's allocation, separate from fare
   settlement.
5. **Security review.** The contract is a demo: admin is a single key
   (the Oruva platform account). Before any mainnet use: multi-signature
   admin, time-locked refunds (auto-refund if a ride never completes),
   and an independent audit.
