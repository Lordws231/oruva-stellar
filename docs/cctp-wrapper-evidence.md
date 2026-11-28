# CCTP wrapper contract: testnet evidence

Date: 28 November 2026. Status: wrapper built, deployed and proven on
Stellar testnet with a Polygon Amoy mint forwarded by Circle. Testnet
only. No real funds, no live NGN payout is claimed.

## What the wrapper does

`contracts/oruva-cctp-wrapper` combines the two Stellar CCTP burn
steps into one invocation under a single caller authorization:

1. `approve` Circle's TokenMessengerMinter to spend exactly the burn
   amount of USDC, with a short expiration ledger passed by the
   caller.
2. `deposit_for_burn_with_hook` (or `deposit_for_burn` when no hook
   data is supplied) on the TokenMessengerMinter.

The caller stays the depositor throughout. The wrapper never takes
custody: CCTP pulls the tokens from the caller with `transfer_from`
inside the same transaction, so the allowance set in step 1 is
consumed by step 2, and a failed burn rolls the allowance back with
it.

Route parameters follow `docs/platform-wiring-spec.md` section 3:
source domain 27 (Stellar), destination domain 7 (Polygon), amounts
at 6-decimal precision inside Stellar 7-decimal units, finality
threshold 2000, `destination_caller` 32 zero bytes, and the 32-byte
version 0 forwarding hook
`0x636374702d666f72776172640000000000000000000000000000000000000000`
so Circle submits the destination mint. The wrapper exposes that
hook through `forwarding_hook()` so callers do not rebuild it.

The mint recipient is always an explicit parameter. The contract
hardcodes no recipient. Oruva's Flutterwave Polygon USDC wallet is
not confirmed yet, so the proof below uses the same clearly labelled
stand-in test address as the earlier Base Sepolia proof,
`0xdceec8abca729fb0b40e86b98baebba9a59e818f`. It is a mechanism
proof only.

Parameter refusals, all covered by host tests: zero or negative
amounts, amounts or fees below 6-decimal precision, the Stellar
domain as destination, a zero mint recipient, a recipient that is
not a left-padded EVM address, a negative max fee or one at or above
the amount, empty hook data, an approve expiration at or before the
current ledger, burning before init, and double init. A burn above
the caller's balance fails inside the pull and rolls the allowance
back.

One design note from the testnet run: the approve expiration ledger
is a burn parameter, not derived from the current ledger inside the
call. The caller's authorization covers the approve arguments, so an
expiration computed at execution time differs from the one recorded
at simulation time and the authorization does not match. The first
testnet burn attempt failed on exactly that
(`auth invalid_action` on the approve subcall, transaction
`d33f5be5b5dec08a1048c0e047afe4c5d9752569459ae8db0307bec3a06af144`,
no funds moved). The parameter fix is in the deployed contract.

## Testnet proof (28 November 2026)

Contracts (testnet):

- Oruva CCTP wrapper: `CCZ4IXX5VUGRWP3DCYXP6Y6RDZJRCLNVPIT4LJPSA4FKDJI2DOFWLYW3`
  https://lab.stellar.org/r/testnet/contract/CCZ4IXX5VUGRWP3DCYXP6Y6RDZJRCLNVPIT4LJPSA4FKDJI2DOFWLYW3
- Circle TokenMessengerMinter: `CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP`
  (interface read on-chain and matched against the wrapper's client
  trait before deployment)
- USDC Stellar Asset Contract: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`

Transactions:

- Deploy: `3fa330e8d69d8f3838fd0a819eb8d7f990930532361c640b5831e6616f236e53`
  https://stellar.expert/explorer/testnet/tx/3fa330e8d69d8f3838fd0a819eb8d7f990930532361c640b5831e6616f236e53
- Init (admin = treasury account, TokenMessengerMinter and USDC SAC
  recorded): `8f780ca033ba539cefb87b867262f81261c0f12a9ac1c0c03a9ca52cc09a7c41`
  https://stellar.expert/explorer/testnet/tx/8f780ca033ba539cefb87b867262f81261c0f12a9ac1c0c03a9ca52cc09a7c41
- Burn 1 USDC through the wrapper, one invocation, driver account as
  caller: `01bdb57a0c763b6b3fe9263c1801bf9fa4b76cd370c0c3429d9710976d623ee7`
  https://stellar.expert/explorer/testnet/tx/01bdb57a0c763b6b3fe9263c1801bf9fa4b76cd370c0c3429d9710976d623ee7
  The transaction emitted the wrapper's `BurnSubmitted` event with
  amount 10000000 (1 USDC in 7-decimal units), destination domain 7,
  the stand-in recipient, max_fee 558930, finality 2000, with_hook
  true. The driver USDC balance moved from 12.28 to 11.28 USDC.

Fee quote at burn time: `GET /v2/burn/USDC/fees/27/7?forward=true`
on the Iris sandbox returned protocol fee 0 bps and forwardFee med
55893 (6-decimal units) at finality threshold 2000. `max_fee` was
set to exactly 558930 in Stellar 7-decimal units, with no buffer.

Attestation and forward (Circle Iris sandbox,
`GET /v2/messages/27?transactionHash=<burn hash>`):

- Status: complete. Event nonce:
  `0xecd95300f930c30dd91d0e3cee350f7f5e8a569dbc37634b129c882af85a443e`
- Forward state: COMPLETE. Polygon Amoy mint/forward transaction:
  `0x98adf35f895a33f1073a342cd3c8854b0df2b3910add7a801e014d82f576027e`
  https://amoy.polygonscan.com/tx/0x98adf35f895a33f1073a342cd3c8854b0df2b3910add7a801e014d82f576027e

Expected mint from the quote: burned 1.000000 USDC, forwarding fee
0.055893, so 0.944107 USDC to the stand-in recipient.

Verification limit, stated plainly: the Amoy mint transaction hash
and forward completion above are Circle's Iris record. An
independent on-chain receipt and recipient-balance check against a
public Amoy RPC was attempted but could not be completed from this
environment (the RPC calls returned no usable response, and the
retry needs an approval that has not been given). The mint leg is
therefore evidenced by Circle's attestation and forward record, not
yet by an independent Amoy receipt read. That read is the one
remaining verification step for this proof.

## What is proven, what is stand-in

Proven on testnet:

- One wrapper invocation approves and burns: a single authorization,
  allowance consumed in the same transaction, `BurnSubmitted`
  emitted, caller balance reduced by exactly the burn amount.
- The burn used the recorded production parameters: destination
  domain 7, finality 2000, zero destination caller, version 0
  forwarding hook, max_fee from the live 27/7 quote with no buffer.
- Circle attested the burn and its Forwarding Service submitted the
  Polygon Amoy mint (Iris record above).
- Host tests: 15 passed, covering approve-plus-burn composition,
  hook and no-hook paths, every parameter refusal, rollback on
  insufficient balance, and the recorded hook bytes.

Stand-in, mechanism proof only:

- The mint recipient `0xdceec8abca729fb0b40e86b98baebba9a59e818f`
  is a test address. Oruva's Flutterwave Polygon USDC wallet is not
  confirmed; no production address exists in the contract or this
  proof.
- All funds are testnet USDC. The earlier two-transaction proof
  (Stellar burn `4587f217`, Base Sepolia mint `0x3181affb`, recorded
  in `docs/dual-confirmation-evidence.md`) remains the Base-route
  mechanism proof; this wrapper proof is the Polygon route.

Superseded deployments from the same build session, kept for the
record: `CDX22EBXKAT5E7O2EBUTFET4HOWKZ7K2U77VFB66QQYGHCOL3KY244DZ`
(deployed by the interrupted earlier session) and
`CB377EXJZIGZIPATYCX5JRGCDIMFUC2GXKPUTHXZLYJCKMR6JSC2PSJD`
(deploy `516b02ca`, init `1eb6969f`; replaced after the approve
expiration authorization fix above). The live wrapper is
`CCZ4IXX5VUGRWP3DCYXP6Y6RDZJRCLNVPIT4LJPSA4FKDJI2DOFWLYW3`.

## Remaining gates

- Independent Amoy receipt and recipient-balance read for mint
  transaction `0x98adf35f` (needs the RPC retry approval noted
  above).
- Flutterwave Polygon USDC wallet address confirmation, recorded as
  configuration, never hardcoded.
- Flutterwave stablecoin approval, IP whitelist, compliance review
  and a small-value live test before any live NGN payout is claimed
  (see `docs/flutterwave-live-gates.md`).
- Platform integration: the production platform bridge adapter calls
  this wrapper with the confirmed recipient and the live quote;
  until then the burn parameters recorded here are its contract.
