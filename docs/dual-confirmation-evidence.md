# Dual-confirmation escrow and CCTP bridge evidence (testnet)

Date: 27 November 2026. Network: Stellar testnet and Base Sepolia.
Testnet only. No real funds. Nothing here is a live payout claim.

## 1. Dual-confirmation escrow instance

A fresh escrow instance with dual-confirmation release was deployed and
verified end to end on 27 November 2026.

- Contract: `CBJSKJ3MROFMWYB2WRAMY237I7PQMIVLE2DMPC4DFDEBG23NYBQ7TUZP`
  https://stellar.expert/explorer/testnet/contract/CBJSKJ3MROFMWYB2WRAMY237I7PQMIVLE2DMPC4DFDEBG23NYBQ7TUZP
- Wasm hash: `aebb5cfbb3632ef3cbbfbe2b258713fd3d5708352ea88fb25d51b7e992daf802`
- Upload wasm: `0836ddbe97f9c5fd0cf8bc05297b94fcafb3c8cc2887aa4de97091d9130d74c5`
- Deploy contract: `e087882b12e67995b699592d5581bd634268cb4a65fd67b950f92479a90d17a3`
- Init (admin = issuer, token = Circle testnet USDC SAC, treasury = Oruva
  treasury): `7a5afedf05b2acb036bfc1596428420c80df5acbbc57ff68d0d56033b2e8210c`
- Fare token: USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`
- Reproduce: `bash scripts/dual-confirmation-demo.sh` (needs the RPC
  proxy; ride ids are single-use, so edit them to run again)

### Ride dual-ride-001 (2 USDC fare, dual-confirmed release)

- Lock fare: `9a1e106152c0ff5318f3e3934f61f320030f509db56fd67b41b1b9a4c585a591`
  https://stellar.expert/explorer/testnet/tx/9a1e106152c0ff5318f3e3934f61f320030f509db56fd67b41b1b9a4c585a591
- Driver confirms arrival (proof ref `proof:dual-arrival-001`):
  `98ffc596ccfee4b8b8df655eab050a4885c915d429bce2512bb5c1a740518254`
- Release attempted with only the driver proof: rejected on-chain
  (passenger authorization missing). The rejected call fails in
  simulation, so it has no transaction hash; the gate is also covered by
  unit tests.
- Passenger authorizes release:
  `67e209551a3018e6f2e8db6ae8b1456af467c84c6e24b899f43d215ba80b31cb`
- Release fare: `875143da8fdb75c4797b5a480232f09982a6a377de30735f86480fafda27d267`
  https://stellar.expert/explorer/testnet/tx/875143da8fdb75c4797b5a480232f09982a6a377de30735f86480fafda27d267
- `get_ride` after release: status `Released`, amount `20000000`,
  `arrival_proof` `proof:dual-arrival-001`, `passenger_authorized` true.
- `get_driver_balance` after release: `20000000`.

### Ride dual-ride-002 (1 USDC fare, cancelled and refunded)

- Lock fare: `cab8e8ce42dd0033a3aa8970fdc390adaf0b088fc5a844fef2e9c641b04e7cf5`
- Refund fare: `04f3ed4e0497948b295c96f827fdc70ecd3e8a68a7a416a8c37537bafeaa6358`
  https://stellar.expert/explorer/testnet/tx/04f3ed4e0497948b295c96f827fdc70ecd3e8a68a7a416a8c37537bafeaa6358

### Phase 2 withdrawal after the dual-confirmed release

- Driver withdraws 2 USDC to the external wallet:
  `43d414f7851ff2aa90a9ca718eda63dc5e9ea3bbe73095a5d74dcd26de12e75e`
  https://stellar.expert/explorer/testnet/tx/43d414f7851ff2aa90a9ca718eda63dc5e9ea3bbe73095a5d74dcd26de12e75e
- `get_driver_balance` after withdrawal: `0`.

### Balances (USDC, read from Horizon)

| Account | Before | After |
| --- | --- | --- |
| Rider | 3.0000000 | 1.0000000 |
| Treasury | 0.5000000 | 0.7000000 |
| External driver wallet | 4.5000000 | 6.3000000 |

The 2 USDC withdrawal split exactly: 1.8 USDC (90%) to the external
wallet and 0.2 USDC (10%) to treasury. The refunded 1 USDC returned to
the rider.

## 2. Circle CCTP leg: Stellar testnet to Base Sepolia

The conversion bridge leg was proven on testnet on 27 November 2026:
Stellar testnet USDC burned through CCTP, attested by Circle, and minted
on Base Sepolia by the Circle Forwarding Service. The mint recipient was
a one-off test address standing in for Oruva's Flutterwave Base USDC
wallet, which is not confirmed yet. The Flutterwave NGN payout leg is
production integration pending stablecoin approval, IP whitelist, wallet
address confirmation, compliance review, and a small-value live test. No
live NGN payout is claimed.

- Route: Stellar (domain 27) to Base (domain 6), finality threshold 2000.
- Fee quote: `GET /v2/burn/USDC/fees/27/6?forward=true` on the Iris
  sandbox returned protocol fee 0 bps and forwardFee 52993 (6-decimal
  USDC units) at the med tier. `max_fee` was set to exactly 529930 in
  Stellar 7-decimal units, with no buffer.
- Approve TokenMessengerMinter to spend 0.6 USDC:
  `fd99aa395b2bba08cd01cf88ba5356a8492ce84a4458750cb738b69ee76ade24`
- Burn 0.6 USDC with the forwarding hook:
  `4587f21721f3c6a0f567a318e754b9cf1428fee338cce054aed8fc6a31d3a956`
  https://stellar.expert/explorer/testnet/tx/4587f21721f3c6a0f567a318e754b9cf1428fee338cce054aed8fc6a31d3a956
- Attestation: `GET /v2/messages/27?transactionHash=<burn hash>` reached
  status complete; forwardState moved PENDING to CONFIRMED.
- Base Sepolia mint/forward transaction:
  `0x3181affb910a1ef619eddc180c6dbbf8ec7694373cbddbd4cf1f4dc17840de5e`
  https://sepolia.basescan.org/tx/0x3181affb910a1ef619eddc180c6dbbf8ec7694373cbddbd4cf1f4dc17840de5e
  Receipt status success, block 64431294.
- Recipient: `0xdceec8abca729fb0b40e86b98baebba9a59e818f` (test address).
- Recipient USDC balance on Base Sepolia: 0 before, 0.547007 after.
  Burned 0.600000, forwarding fee 0.052993, minted 0.547007.

Contracts used (testnet): TokenMessengerMinter
`CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP`, MessageTransmitter
`CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY`, USDC SAC
`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`, Base Sepolia
TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`, Base Sepolia
USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

## 3. What is not proven here

- Live Flutterwave NGN payout: pending stablecoin approval, IP
  whitelist, wallet-address confirmation, compliance review, and a
  small-value live test.
- The one-signature wrapper flow (approve plus burn in one
  authorization): specified in `docs/platform-wiring-spec.md`, not yet
  built. The proof above used the two-transaction flow.
- Platform wiring: the production Oruva platform does not call this
  contract yet. The wiring build follows the spec in
  `docs/platform-wiring-spec.md`.
