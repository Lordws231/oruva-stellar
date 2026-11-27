# Oruva Stellar Settlement Rails

Fare settlement for Oruva Transportation Services, built for the Stellar
Buildathon (Build Week 25-30 November 2026, submission 1 December 2026).

**Testnet only. No real funds. Nothing here touches mainnet.**

## What it is

When a rider books a ride, the fare is locked in a Soroban escrow contract.
When the trip completes, release needs two confirmations: the driver
records an arrival proof reference and the passenger authorizes the
release. Only then is the fare credited to the driver's withdrawable
balance; the admin cannot release a fare alone. The driver can withdraw
to an external Stellar wallet: Oruva keeps exactly 10% and the driver
submits and pays for the withdrawal transaction. When the ride is
cancelled, the admin refunds the fare to the rider. Every step emits an
on-chain event the Oruva platform can index.

Payment rails: Paystack is the default fiat rail, Stellar is the crypto
settlement rail, and Flutterwave is only the crypto conversion end
(Stellar USDC to Circle CCTP to Polygon USDC to Flutterwave stablecoin
wallet to NGN offramp at Flutterwave's 1.5% offramping fee; Oruva's
displayed rate is the Flutterwave rate reduced by 15%). Each user has one visible Oruva account
number: their Paystack Dedicated Virtual Account. Converted NGN is sent
by Flutterwave as a bank transfer into that Paystack DVA, and the user
withdraws manually from the Oruva/Paystack balance to their personal
bank account. No separate Flutterwave account number is shown. Crypto
itself never enters Paystack; only converted NGN arrives by bank
transfer. Oruva's internal ledger joins the rails with source-tagged
sub-balances. Live Flutterwave NGN payout is pending stablecoin
approval, IP whitelist, wallet-address confirmation, compliance review,
and a small-value live test; Paystack DVA receiving for this flow is
also unverified until Paystack confirms enablement and receiving rules.
Nothing here claims live NGN payout. The full wiring design is in
`docs/platform-wiring-spec.md`.

- **Fare token:** in the live design, fares move in USDC on Stellar. The
  first testnet demo used **TUSD**, a test-issued asset that stands in for
  USDC. A fresh escrow instance was then deployed against real Circle
  testnet USDC and verified end to end on 25 November 2026. The escrow
  contract is token-agnostic: swapping the fare token is a deployment
  configuration change, not a code change.
- **ORVA:** the Oruva reward token, issued on Stellar testnet as
  `ORVA:GBMC7N2HJSNHLPN2NIKTTUI2ZYJ6FFRN6IVTTTRARGRA4TZ7YHL45FOD`.
  Rewards and referral bonuses are a separate flow from fare settlement and
  are not part of this contract yet.

## Architecture

```text
Rider ──lock_fare──▶ oruva-escrow ──release_fare──▶ Driver balance
  (fare token)        (holds fare)     (needs driver arrival
  ▲                                    proof + passenger
  └──refund_fare── (admin confirms    authorization)
                    cancellation)

Driver balance ──withdraw──▶ External Stellar wallet (90%)
                         └──▶ Oruva treasury (10%)
Driver balance ──CCTP bridge──▶ Polygon USDC ──▶ Flutterwave wallet
                             ──▶ NGN conversion ──▶ transfer into
                             the user's Paystack DVA (one visible
                             account number; live leg pending
                             Flutterwave and DVA gates)
```

- `contracts/oruva-escrow` — the Soroban contract (Rust, soroban-sdk 29).
  - `init(admin, token, treasury)` — one-time setup; admin is the Oruva
    platform and treasury receives the withdrawal charge.
  - `lock_fare(rider, driver, amount, ride_id)`: rider authorizes; pulls
    the fare into escrow; ride becomes `Locked`. One ride id, one escrow.
  - `confirm_arrival(driver, ride_id, proof_ref)`: driver authorizes;
    records the arrival proof reference the platform derives from its
    location evidence. The contract stores the reference; it does not
    verify GPS itself. The first proof wins; repeating the same proof is
    accepted so retries are safe.
  - `authorize_release(rider, ride_id)`: passenger authorizes the
    release. Repeating it is accepted.
  - `release_fare(ride_id)`: credits the driver's withdrawable balance,
    but only when both confirmations are present; `Released`. With both
    present the release is mechanical, so any submitter may call it. The
    admin cannot release without the two confirmations.
  - `withdraw(driver, destination, amount)`: driver authorizes and
    submits; sends 90% to the destination and 10% to treasury.
  - `refund_fare(ride_id)`: admin only; refunds the rider; `Refunded`.
  - `get_ride(ride_id)` and `get_driver_balance(driver)`: read-only state.
  - Events: `FareLocked`, `ArrivalConfirmed`, `ReleaseAuthorized`,
    `FareReleased`, `FareRefunded`, `DriverWithdrawal` (ride id or
    driver is a topic, so records are filterable).
- `backend/` — Node service layer for default Stellar wallets, wallet
  activation, external deposit crediting, payout preferences, conversion
  quotes, and payout adapters. Live eNaira and bank payout still require
  partner credentials and funded settlement accounts; the testnet build
  exercises the same orchestration with simulated payout adapters.
- `tools/rpc-proxy.py` — local reverse proxy for the Stellar testnet RPC.
  Needed on this VM because it has no direct internet egress: outbound
  traffic must go through the egress proxy in `HTTPS_PROXY`, which the
  Stellar CLI's HTTP client ignores. The proxy listens on 127.0.0.1:8765
  and forwards to `https://soroban-testnet.stellar.org/` via curl.
- `scripts/demo.sh` — the end-to-end demo (see below).
- `deployed-contract.txt` — the TUSD escrow contract id used by
  `scripts/demo.sh`. The USDC instance id is recorded in the deployment
  table below.
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
| USDC asset (Circle testnet) | `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| USDC Stellar Asset Contract | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (already deployed; decimals 7, verified 24 Nov 2026) |
| oruva-escrow contract, TUSD instance | `CBKN5SUUG6GV6XPX36RYZ4ABNZOBU3SXAF4MQBYP32QXGA7YJ3DOJWLA` |
| oruva-escrow contract, USDC instance | `CCOUXV4H2TE2QDVANODMQNV3ZXFUBBP44PAWSZMH326GQRBJIMI2DGNK` |
| oruva-escrow contract, phase 2 USDC instance | `CC52W5DFFF4QM3KEOD6DRJKHCCCQ53MZDH7RQ2EZVOMUYFO25SEYDUYB` |
| oruva-escrow contract, dual-confirmation USDC instance | `CBJSKJ3MROFMWYB2WRAMY237I7PQMIVLE2DMPC4DFDEBG23NYBQ7TUZP` |
| Oruva treasury (phase 2) | `GDSHAMDZPFBQR6EYFBVR3ZI7HZUSOE4G3VTQHVPVSM7XRK7WPMPXFF3J` |
| External driver wallet (phase 2 demo) | `GCTCGJZXOOCE7XO3RHANVQFO7IGHLEBOQ35M2WUNVCCBHUUVDUXMGLR7` |

Stellar Expert (testnet), TUSD instance: https://stellar.expert/explorer/testnet/contract/CBKN5SUUG6GV6XPX36RYZ4ABNZOBU3SXAF4MQBYP32QXGA7YJ3DOJWLA

Stellar Expert (testnet), USDC instance: https://stellar.expert/explorer/testnet/contract/CCOUXV4H2TE2QDVANODMQNV3ZXFUBBP44PAWSZMH326GQRBJIMI2DGNK

Stellar Expert (testnet), phase 2 instance: https://stellar.expert/explorer/testnet/contract/CC52W5DFFF4QM3KEOD6DRJKHCCCQ53MZDH7RQ2EZVOMUYFO25SEYDUYB

Stellar Expert (testnet), dual-confirmation instance: https://stellar.expert/explorer/testnet/contract/CBJSKJ3MROFMWYB2WRAMY237I7PQMIVLE2DMPC4DFDEBG23NYBQ7TUZP

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

USDC trustlines (set 24 November 2026; Circle faucet claim landed before the
25 November 2026 USDC demo):

- Rider trustline: `ee0bea1ab45ac618d681925b1e1950378d933d3a895b046217c2b935d49c4994`
- Driver trustline: `8e707e8c8d0d7512027a097bfd7c339801f1716c90264ab31ad02fdb6647be8b`
- USDC SAC already deployed (decimals 7, name `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`); no deploy needed.
- Rider USDC balance before the USDC demo: 20.0000000 USDC, read from the
  USDC SAC `balance` call.

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

Final TUSD demo balances: rider 475 TUSD, driver 25 TUSD.

### USDC demo (verified 25 November 2026)

A fresh escrow instance was deployed for real Circle testnet USDC because
`init` is one-time. The TUSD instance above stays as-is.

- USDC escrow contract: `CCOUXV4H2TE2QDVANODMQNV3ZXFUBBP44PAWSZMH326GQRBJIMI2DGNK`
- Wasm hash: `5ba42f8990d1b38b8839f20a5bcce36f1d05b7b1ed8bdd5614cc13874880e097`
  (the deploy skipped install because that wasm was already installed)
- Deploy contract: `522ef569845e3197aa931426953cc991fcb32909ca92fcb5ef81eb9761c1a53a`
- Init (admin = issuer, token = USDC SAC): `57618bec2fc13b60b22324ed666b8db4688288c4e00782e71f9fd7832b4cd29a`

Demo, `usdc-ride-001` (12 USDC fare, completed):

- Lock fare: `30abfd213855d5861254d45ae7f6fd2b18ff106c50a36307a7008b5059ad8826`
- `get_ride` after lock: `Locked`, amount `120000000`
- Release fare to driver: `b7daa1340a6574f32a29b054a61fc680bd90b61e979d314aa3c18a8ac9fc41b8`
- `get_ride` after release: `Released`, amount `120000000`

Demo, `usdc-ride-002` (5 USDC fare, cancelled and refunded):

- Lock fare: `04f6a71550fa1c444749aa2e1f047fc9cb3d8cf07fe6cd07996b1c7911708af0`
- `get_ride` after lock: `Locked`, amount `50000000`
- Refund fare to rider: `dda7176fb3f191693d2058153db059cbd007a6b03968ee016a9188f13d07a1b9`
- `get_ride` after refund: `Refunded`, amount `50000000`

Final USDC balances, read from the USDC SAC `balance` call: rider
8.0000000 USDC (`80000000`), driver 12.0000000 USDC (`120000000`), escrow
contract 0 USDC (`0`).

### Phase 2 withdrawal demo (verified 26 November 2026)

A fresh phase 2 instance adds driver balances and external withdrawals.
The driver submits the withdrawal transaction, so the driver pays its
Stellar fee.

- Phase 2 contract: `CC52W5DFFF4QM3KEOD6DRJKHCCCQ53MZDH7RQ2EZVOMUYFO25SEYDUYB`
- Wasm hash: `a8cd8f9618ed1996bd17ac985662c4328ccda24e6801189e901b254364c0441e`
- Deploy contract: `eaf272305b6d1a72b2cc47465d3f6c11f597a1e17b12a725fc7455813e314c49`
- Init (admin = issuer, token = USDC SAC, treasury = Oruva treasury):
  `bad54b03e3d97f916961ce04b8463485e9746a51026318d8b841ec7a1bb1c21a`
- Lock 5 USDC for `phase2-ride-001`:
  `6bdd51635fe6d01bb57af1ae289fb54b222d6134e65f10a5af3a169caaeef5cc`
- Release into driver balance:
  `9b134dba8f07ff30ebe960091dfe2d054b4de25ab4501a55e40857e0c5cf94da`
- `get_driver_balance` after release: `50000000`
- Driver withdraws 5 USDC to the external wallet:
  `b83109f267775d781d5e4ac5bd0502b28102fe59c05a56cced3bea5637f401fe`
- `get_driver_balance` after withdrawal: `0`
- Final balances: rider 3.0000000 USDC, treasury 0.5000000 USDC, external
  wallet 4.5000000 USDC.

Backend wallet verification on the same day: the backend provisioned and
activated a default driver wallet (`GA4A4NUDF65SQ37S2IAESNFVP4LBZNGE2NSJ6YXJ35NEB4HFOOSJEJCZ`),
an external 1 XLM payment landed in transaction
`9fccca445a76164d86bbae62be76a206f1496892689353c31d85282c20cf78dc`, and
the Horizon sync credited it once.

### Dual-confirmation release and CCTP bridge leg (verified 27 November 2026)

Release now needs two confirmations: the driver's arrival proof and the
passenger's authorization. A fresh instance
(`CBJSKJ3MROFMWYB2WRAMY237I7PQMIVLE2DMPC4DFDEBG23NYBQ7TUZP`) was deployed
and verified: a 2 USDC fare locked, a release with only the driver proof
rejected on-chain, then passenger authorization and release, a 1 USDC
fare refunded on a second ride, and a 2 USDC withdrawal split 90/10.

The Circle CCTP conversion leg was also proven on testnet the same day:
0.6 USDC burned on Stellar testnet, attested by Circle, and minted on
Base Sepolia by the Forwarding Service (0.547007 USDC after the
0.052993 forwarding fee). The mint recipient was a one-off test address
standing in for Oruva's Flutterwave Base USDC wallet, which is not
confirmed yet. Full hashes, links, and balances are in
`docs/dual-confirmation-evidence.md`. The Flutterwave NGN payout leg
stays pending stablecoin approval, IP whitelist, wallet-address
confirmation, compliance review, and a small-value live test.

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
runs the dual-confirmation release on completion, shows the ride
`Released`, and prints balances before and after. Each ride id can only
be used once; edit `RIDE_ID` in the script (and fund the rider with more
TUSD if needed) to run it again. `scripts/dual-confirmation-demo.sh`
deploys a fresh USDC instance and verifies the full dual-confirmation
flow, including a release attempt with only one confirmation.

## Tests

```sh
cargo test -p oruva-escrow
```

22 contract tests, all passing (27 November 2026): lock moves funds and
records the ride (including the `FareLocked` event), dual-confirmed
release credits the driver balance, release with only the driver proof
rejected, release with only the passenger authorization rejected,
release with no confirmations rejected, wrong driver and wrong rider
confirmations rejected, empty proof rejected, confirmations are
retry-safe, confirmations after refund rejected, withdrawal sends 90% to
the external wallet and 10% to treasury, partial withdrawal keeps the
remaining balance, over-balance and zero withdrawals are rejected,
refund returns the fare, double-lock rejected, release-after-refund
rejected, unknown ride rejected, zero lock rejected, double init
rejected, unknown ride reads as None.

Backend tests:

```sh
cd backend && npm test
```

8 backend tests, all passing (26 November 2026): default rider and driver
wallet provisioning, wallet activation, external deposit crediting,
omnibus memo crediting, the 10% withdrawal split, external Stellar payout,
and opt-in eNaira and bank payout orchestration with simulated adapters.

## Build and deploy

```sh
stellar contract build
stellar contract deploy --wasm target/wasm32v1-none/release/oruva_escrow.wasm \
  --source-account issuer --alias oruva-escrow
stellar contract invoke --id oruva-escrow --source-account issuer -- \
  init --admin <issuer-address> --token <fare-token-contract-address> \
  --treasury <treasury-address>
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

## Why TUSD came first

TUSD was the first fare token because the Circle faucet is an interactive
web form and could not be completed from this VM during the first build.
TUSD is issued by the Oruva testnet issuer account and is clearly labelled
everywhere as a stand-in. After the founder claimed Circle testnet USDC to
the rider account, the same contract was deployed as a fresh instance
against the USDC SAC and verified with real testnet USDC. No contract code
change was needed.

## What is next

1. **Live payout partners.** The conversion bridge is Circle CCTP:
   Stellar USDC to Polygon USDC to Flutterwave stablecoin wallet to NGN
   offramp, then a Flutterwave bank transfer into the user's Paystack
   DVA (the one visible Oruva account number), with manual withdrawal
   from there. The CCTP leg is proven on testnet (see
   `docs/dual-confirmation-evidence.md`). Live Flutterwave NGN payout
   still needs stablecoin approval, IP whitelist, wallet-address
   confirmation, compliance review, and a small-value live test; Paystack
   DVA receiving for this flow is unverified until Paystack confirms
   enablement and receiving rules (requested 23 November 2026, reply
   awaited). The simulated adapters stay in place until those gates
   clear. Fallback if CCTP forwarding is unavailable: ROZO or NEAR
   Intents routing; Oruva inventory conversion is an emergency fallback
   only.
2. **Platform wiring.** The backend service layer in `backend/` provisions
   default wallets, credits external deposits, stores payout preferences,
   and orchestrates withdrawals and conversions. The production Oruva
   platform still needs to call `lock_fare` on ride acceptance, run the
   dual-confirmation release on trip completion, call `refund_fare` on
   cancellation, index the contract events for settlement records, and
   run the CCTP bridge adapter. The wiring design, including the
   source-tagged ledger sub-balances and the payout state machine, is in
   `docs/platform-wiring-spec.md`.
3. **ORVA rewards.** A second flow that pays ORVA bonuses (referrals,
   completed-ride rewards) from Oruva's allocation, separate from fare
   settlement.
4. **Security review.** The contract is a demo: admin is a single key
   (the Oruva platform account). Before any mainnet use: multi-signature
   admin, time-locked refunds (auto-refund if a ride never completes),
   and an independent audit.
