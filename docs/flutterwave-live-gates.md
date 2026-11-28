# Flutterwave live gates pack: Oruva Stellar payouts

Date: 28 November 2026. Status: documentation only. Nothing in this pack
moves live money, calls a live API, sends an email, or changes any
account. It records what must be true, and who must do what, before the
first live NGN payout through Flutterwave is allowed to happen.

## The payout path this pack gates

Stellar USDC (escrow release) to Circle CCTP burn (source domain 27) to
Polygon USDC mint (destination domain 7) into Oruva's Flutterwave
stablecoin wallet, then Flutterwave conversion to NGN, then a Flutterwave
NGN bank transfer into the user's Paystack Dedicated Virtual Account
(DVA). The user withdraws manually from the Oruva/Paystack balance. The
app shows one account number per user, the Paystack DVA. Crypto itself
never enters Paystack. The full design is in
`docs/platform-wiring-spec.md` sections 1 and 3.

Flutterwave account registration and face verification are done
(27 November 2026). Stablecoin access is a separate approval and is not
live. Live NGN payout stays gated on five items:

1. Flutterwave stablecoin approval.
2. IP whitelist.
3. Wallet-address confirmation.
4. Compliance review.
5. A small-value live test (section 6 of this pack).

Until all five clear, every surface (app, docs, submission pack) labels
the Flutterwave leg as integration in progress. No surface claims live
NGN payout.

## Status key

- **Done**: completed and evidenced in the workspace record.
- **Pending**: not done; Oruva or Flutterwave action remains.
- **Founder-only**: only the founder can do it (dashboard sign-in,
  identity steps, credential entry, or a money decision). Each
  founder-only step states the exact smallest action.

## 1. Stablecoin approval checklist

### What Flutterwave requires

Flutterwave stablecoin (crypto to NGN) access is granted per account,
separately from ordinary account registration. The workspace record
shows Flutterwave lists inbound stablecoin networks as Polygon and
Ethereum, and outbound networks as Polygon, Ethereum, Solana and Base.
Polygon is therefore the CCTP destination for Oruva. Base is an
alternative only if Flutterwave confirms Base inbound funding for
Oruva's account in writing.

The exact approval checklist Flutterwave applies to a Nigerian
registered business for stablecoin access (document list, volume limits,
settlement terms) is not in the workspace record and has not been
confirmed with Flutterwave. It must be obtained from Flutterwave in
writing; this pack does not invent it. Section 5 lists the documents
and answers Oruva should have ready either way.

### What Oruva has already submitted (Done)

- Account created 26 November 2026 under admin@oruva.com.ng, email
  verified, account opened in test mode with Collect Payments selected.
- Activation as a Registered Business. CAC lookup matched ORUVA
  TRANSPORTATION SERVICES LTD, RC 9972570.
- Business details saved: category Transportation Services, subcategory
  Taxicabs and Limousines, estimated monthly transaction volume
  NGN 1 to 1,000, with the Oruva mobility and haulage description.
- Contact information saved after SMS phone verification for the
  founder's number, business email admin@oruva.com.ng, website
  https://oruva.com.ng.
- Supporting documents uploaded and accepted by Flutterwave on
  26 November 2026: Certificate of Incorporation and Memorandum and
  Articles of Association (each within the 2MB limit).
- Business Representative Information completed: PEP status declared
  (No), attestation checked, Mono identity verification completed with
  BVN checked and address verification checked (utility bill upload).
  The founder completed the typed NIN entry himself in browser
  takeover.
- Face verification done, confirmed by the founder on 27 November 2026:
  the Flutterwave account is successfully registered.

### What remains (Pending)

- Stablecoin access approval itself. No approval, enablement, or
  stablecoin wallet has been confirmed on the account. Registration
  alone does not grant it.
- Flutterwave's written requirements for stablecoin approval for this
  account (documents, limits, fees confirmation, settlement timing).
- Confirmation in writing that Polygon inbound stablecoin funding is
  enabled for Oruva's account (the design assumes it from Flutterwave's
  published network list; account-level enablement is unverified).
- Live-mode activation state of the account for payouts. The account
  was created in test mode; the record does not confirm a live-mode
  switch for stablecoin payouts.

### Founder-only steps (smallest action each)

1. **Founder-only**: sign in to the Flutterwave dashboard as
   admin@oruva.com.ng and open the stablecoin or crypto section.
   Smallest action: take one screenshot of what the section shows
   (enabled, apply, or unavailable) and send it to David. That single
   screen decides whether the next step is an application form or a
   support request.
2. **Founder-only**: if the dashboard offers a stablecoin application
   or enablement form, complete and submit it in the dashboard.
   Smallest action: submit the form; David prepares any text answers
   in advance from section 5.
3. **Founder-only**: if no in-dashboard route exists, approve the exact
   text of a support request to Flutterwave asking for stablecoin
   access for ORUVA TRANSPORTATION SERVICES LTD (RC 9972570) and the
   written requirements list. Smallest action: reply "approved" to the
   draft David shows, with the From address admin@oruva.com.ng shown.
   Nothing is sent before that approval.

## 2. IP whitelist

### What Flutterwave will need

Flutterwave API access for live payouts is normally restricted to
whitelisted server IP addresses. Flutterwave will need the public IP
address (or addresses) that Oruva's platform server calls the
Flutterwave API from. That is the outbound (egress) IP of the Railway
service running the Oruva platform, not the public domain and not any
user's phone IP.

### The honest position on Railway egress

- The Oruva platform runs on Railway (service oruva-platform, project
  oruva-platform-staging, production environment).
- Railway does not give a service a fixed outbound IP by default; the
  egress address can change across deploys and restarts. No static
  egress IP for Oruva's Railway service is recorded in the workspace,
  and no IP address is stated in this pack because none is verified.
- Whitelisting a temporary egress IP is not a durable fix: the next
  deploy can change it and live API calls would fail closed.

### Options, in order of preference

1. **Static outbound IPs on Railway.** Railway offers static outbound
   IP options on some plans. Whether Oruva's current Railway plan
   includes them, and at what cost, is unverified in the workspace
   record and must be checked in the Railway dashboard before any
   spend. Cash is tight; flag the cost to the founder before enabling
   anything paid.
2. **A fixed egress proxy.** Route Flutterwave API calls through a
   small fixed-IP proxy (for example a single small VPS) whose IP is
   whitelisted. Adds a moving part and a monthly cost; only if option
   1 is unavailable or more expensive.
3. **Ask Flutterwave what they accept.** Some providers accept a small
   set of IPs, an IP range, or key-based controls instead of a single
   static IP. Ask Flutterwave in writing which forms of whitelisting
   they support for stablecoin payouts, and whether the whitelist can
   hold more than one address during a transition.

### What to give Flutterwave

Once a static egress IP exists: the exact IPv4 address (and IPv6 if
used), the environment it belongs to (production), and a named contact
for changes. Give only the address itself, never credentials. Record
the whitelisted address, the date, and Flutterwave's confirmation in
the payout evidence trail.

### Founder-only steps (smallest action each)

1. **Founder-only**: in the Railway dashboard, open the oruva-platform
   service settings and check whether static outbound IPs are available
   on the current plan and what they cost. Smallest action: send David
   one screenshot of that settings area. David cannot open the Railway
   account; no Railway credentials are held for the assistant.
2. **Founder-only**: approve or decline the cost of the chosen static
   egress option. Smallest action: reply with the decision; nothing
   paid is enabled before it.
3. **Founder-only**: enter the confirmed static IP into the Flutterwave
   dashboard whitelist (or approve the exact support text asking
   Flutterwave to whitelist it). Smallest action: paste the one IP
   address David provides into the whitelist field and save.

## 3. Wallet-address confirmation

### The rule

The CCTP mint recipient is Oruva's Flutterwave Polygon USDC wallet
address. It is not confirmed yet. It is never hardcoded from memory,
never copied from a screenshot of another account, and never invented.
The platform reads it from configuration (`CCTP_MINT_RECIPIENT`), and
the bridge refuses to burn while that configuration is absent.

### Confirmation steps

1. **Founder-only**: sign in to the Flutterwave dashboard as
   admin@oruva.com.ng, open the stablecoin wallet for USDC, and select
   the Polygon network. Smallest action: copy the deposit address the
   dashboard shows for Polygon USDC and send it to David in chat. The
   address is a public deposit address, not a secret; the password and
   any code stay founder-only and are never sent.
2. David records the address as the candidate `CCTP_MINT_RECIPIENT`
   value in the deployment configuration, with the date and the
   dashboard source noted. The value is set in Railway configuration
   by the founder (Railway variable edits are founder-only); David
   states the exact variable name and value to paste.
3. Verification before the address is trusted: a small test deposit
   (section 6 covers the full test; the address check inside it is a
   minimal USDC amount arriving on Polygon). The deposit must appear
   in the Flutterwave dashboard balance for the Polygon USDC wallet,
   and the Polygon transaction hash must show the same recipient
   address. Both must match before the address is treated as confirmed.
4. If the dashboard ever shows a different address for Polygon USDC
   (rotation, new wallet), the configuration value is treated as stale
   until steps 1 to 3 repeat. Burns stay refused while the confirmed
   address and the dashboard address disagree.

### Status

- **Pending**: no Flutterwave Polygon USDC wallet address is confirmed
  in the workspace record.
- **Done**: the platform side is ready to consume it. Build 0440 wired
  the BridgeAdapter so the burn refuses without `CCTP_MINT_RECIPIENT`
  configuration, and no address is hardcoded anywhere.

## 4. Fee and FX quote handling

### The recorded conversion spec (founder, 27 November 2026)

- Users choose Automatic Convert or manual Convert for USDC.
- Oruva displayed rate = Flutterwave USDC/NGN rate x 0.85.
  Formula: `displayed_rate = flutterwave_rate * 0.85`.
- NGN credit = USDC amount x displayed rate, minus the Flutterwave
  crypto conversion fee.
  Formula:
  `ngn_credit = usdc_amount * displayed_rate - flutterwave_crypto_conversion_fee`.
- Flutterwave lists stablecoin offramping (RLUSD/USDT/USDC to NGN/USD)
  at 1.5%, onramping at 1.5%, inbound external-wallet funding at $1.5
  flat, outbound external-wallet payout at $1.5 flat,
  Flutterwave-to-Flutterwave stablecoin transfers free, with network
  gas fees added by the selected network.
- For Oruva's USDC to NGN conversion, the 1.5% offramping fee is the
  crypto conversion fee in the formula. The live quote returned at
  conversion time is still recorded; the listed 1.5% does not replace
  the quote.

### Worked example (from build 0440)

- Flutterwave rate: 1,400 NGN per 1 USDC.
- Displayed rate: 1,400 x 0.85 = 1,190 NGN per USDC.
- Amount: 200 USDC. Gross at the displayed rate: 200 x 1,190 =
  238,000 NGN.
- Fee at 1.5% of the displayed gross: 3,570 NGN. Net before any
  inbound, gas, or transfer charges: 234,430 NGN.
- The fee line above shows one reading of the fee basis. The open
  question below decides which reading is correct; the example does
  not settle it.

### The fee basis question to confirm in writing

Confirm with Flutterwave, in writing, whether the 1.5% offramping fee
is calculated on the Flutterwave gross conversion value (USDC amount x
Flutterwave rate, before Oruva's 0.85 display adjustment) or on the
amount presented by Oruva. The platform currently computes on the
gross value; if the live Flutterwave quote differs, the quote wins and
the difference is reconciled, never silently absorbed. The written
answer is filed with the payout evidence.

**Founder-only**: approve the exact text of the fee-basis question to
Flutterwave. Smallest action: reply "approved" to the draft David
shows, From admin@oruva.com.ng. David drafts it; nothing is sent
before approval.

### Quote recording at conversion time

Every conversion records, in the payout trail:

- The Flutterwave rate quoted, the displayed rate (x 0.85), the USDC
  amount, the gross NGN, the conversion fee charged, and the final NGN
  credit.
- The quote source and timestamp, and the Flutterwave conversion
  reference once conversion completes.
- For manual Convert, the user sees the displayed rate, USDC amount,
  gross NGN, fee, and final credit before confirming. For Automatic
  Convert, the same calculation runs at conversion time and the quote
  is recorded the same way.
- The CCTP fee quote is recorded separately (protocol fee plus forward
  fee), quoted at payout creation with an expiry, re-quoted only before
  the burn, never after.

## 5. Compliance review pack outline

Flutterwave, and any compliance reviewer behind the stablecoin
approval, will ask for business identity, ownership, source of funds,
payout purpose, and expected volumes. Each item below is marked ready
(on file or already submitted) or owed.

### Ready

- Certificate of Incorporation for ORUVA TRANSPORTATION SERVICES LTD,
  RC 9972570. Uploaded to Flutterwave and accepted 26 November 2026.
- Memorandum and Articles of Association. Uploaded and accepted
  26 November 2026.
- CAC lookup match on file: RC 9972570, Limited Company, registered
  address in Osogbo, Osun State (No 3, Oluyemi Oyaniyi Street, Olofaa
  Estate, Offatedo, Osogbo, postcode 230001).
- Business description already saved with Flutterwave: transportation
  services, ride booking and driver matching, solo, shared, bike,
  mini-bus and Keke services, moving, haulage and delivery,
  field-testing in Osogbo ahead of pre-launch, built for expansion
  across Nigeria.
- Business representative verification completed: BVN checked, address
  verification checked, NIN entered by the founder, PEP declared No,
  face verification done.
- Payout purpose statement (ready to give): conversion of driver and
  rider USDC earnings from Stellar-settled rides into NGN, paid by bank
  transfer into the user's Paystack DVA for manual withdrawal. One
  visible account number per user. Crypto never enters Paystack.
- Source of funds statement (ready to give): USDC fare earnings
  released from the Oruva Stellar escrow after dual confirmation, with
  a per-payout audit trail (ride ID, Stellar burn hash, CCTP mint
  hash, Flutterwave conversion and transfer references, Paystack DVA
  credit reference). Daily reconciliation flags breaks and never
  auto-adjusts.

### Owed

- **Founder-only**: expected volume figures for stablecoin payouts
  (monthly USDC volume, number of payouts, average payout size, peak
  single payout). The registration estimate on file is NGN 1 to 1,000
  monthly transaction volume, which does not describe stablecoin
  payouts. Smallest action: confirm the four numbers David drafts from
  the pre-launch plan (1,000-user Osogbo goal, 17 December 2026) or
  correct them. No figures are submitted to Flutterwave without the
  founder's confirmation.
- **Founder-only**: director and shareholder details beyond the
  founder, if Flutterwave asks (co-founder Oluwaseun Fatore holds 30%,
  the founder 70%). Smallest action: confirm which identity documents
  the co-founder can provide if asked; nothing is requested from the
  co-founder until Flutterwave actually asks.
- **Founder-only**: a settlement bank account confirmation for
  Flutterwave payouts, if Flutterwave requires one for the stablecoin
  product. The Oruva settlement bank on the Paystack side is
  Moniepoint MFB; whether Flutterwave needs its own confirmed account
  is unverified. Smallest action: confirm the account details in the
  Flutterwave dashboard if the stablecoin application asks; account
  numbers are entered by the founder in the dashboard only, never in
  chat.
- Pending: any additional documents Flutterwave's written requirements
  list names (section 1). The list itself is owed by Flutterwave.
- Pending: Paystack DVA receiving confirmation. The converted NGN
  lands in the user's Paystack DVA, and DVA enablement and receiving
  rules are still unverified with Paystack (follow-up sent
  27 November 2026, answers demanded by 30 November 2026). This is a
  Paystack gate, not a Flutterwave gate, but the live test in section
  6 cannot pass end to end until it clears. If DVA receiving is not
  enabled for this flow, the ledger design stays ready and users are
  never shown a second account number as a workaround.

## 6. Small-value live-test runbook

### Preconditions (all must be green before the test starts)

1. Stablecoin approval confirmed on the Flutterwave account, with
   Polygon inbound funding enabled (section 1).
2. IP whitelist set to the static egress IP, and a non-money API read
   (for example a balance or status lookup) succeeds from the platform
   server (section 2).
3. Wallet address confirmed by the dashboard copy and recorded as
   `CCTP_MINT_RECIPIENT` (section 3, steps 1 and 2; step 3 is proven
   inside this test).
4. Fee basis answered in writing, or the test explicitly records the
   live quote fee and treats the basis question as answered by the
   quote evidence (section 4).
5. Compliance review passed or explicitly not required for the test
   amount by Flutterwave in writing (section 5).
6. Paystack DVA receiving confirmed for the test user's DVA, so the
   final landing step can be verified.
7. The platform Stellar path is production-ready for the test: the
   Stellar SDK transaction builder and the CCTP wrapper contract are
   built and the stellar router is deliberately enabled. As of
   28 November 2026 these are not built (build 0440 shipped the wiring
   dark, with a simulated bridge test double), so this precondition is
   currently red. The test does not start until it is green.

### Test amount limits

- One payout only. USDC amount at the smallest practical size that
  clears Flutterwave minimums and fees with a readable result; the
  exact figure is set at test time from the live quote and confirmed
  by the founder before the burn. As a ceiling, the test stays at or
  below 10 USDC unless the founder approves a higher figure in
  writing.
- The test uses the founder's own Oruva account as the payout user, so
  no third party's money is involved.
- **Founder-only**: approve the exact test amount and the exact test
  user before the burn. Smallest action: reply with the amount
  approval; the burn does not happen without it.

### Step by step

1. Create the payout record with a single-use payout ID. Record the
   CCTP fee quote (protocol fee plus forward fee, finality threshold
   2000) and the conversion quote (Flutterwave rate, displayed rate,
   gross NGN, fee, final credit) with expiry. State: `quoted`.
2. Preflight: source wallet USDC balance covers the amount, XLM covers
   fee and reserve, mint recipient configuration is present and matches
   the confirmed dashboard address.
3. Burn on Stellar through the wrapper flow (approve plus
   `deposit_for_burn_with_hook`, destination domain 7, mint recipient
   left-padded to 32 bytes, destination caller zero bytes, precise
   `max_fee`, forwarding hook). Record the burn hash. State: `burned`,
   amount moves to `pending_bridge`. Never re-burn after a successful
   burn.
4. Poll attestation until complete, then until `forwardState` is
   CONFIRMED with a `forwardTxHash`. Record both. States:
   `attesting`, then `minted`.
5. Verify the Flutterwave credit: the Polygon mint hash recipient
   equals the confirmed wallet address, and the Flutterwave dashboard
   or API shows the USDC credit. This completes section 3 step 3.
   State: `credited`.
6. Convert USDC to NGN at the recorded quote. Record the conversion
   reference and the actual fee charged; compare against the quote and
   the fee basis answer. State: `converted`.
7. Flutterwave sends the NGN bank transfer into the test user's
   Paystack DVA. Verify the DVA credit and its reference. State:
   `paid`. The amount lands in `paystack_ngn_available` tagged with its
   crypto source.
8. Reconcile the full chain by payout ID: ride or test reference,
   Stellar burn hash, CCTP mint hash, Flutterwave credit, conversion
   and transfer references, Paystack DVA credit reference, fees at
   each step, final bank status.

### Rollback (how to stop, and how funds return)

- Before the burn: stopping is free. Cancel the payout record; the
  USDC never left `stellar_usdc_available`. No chain action exists to
  undo.
- After the burn, before the mint: the burn cannot be undone. Do not
  re-burn. Keep polling attestation; CCTP forwarding completes the
  mint. The payout stays in `pending_bridge` until the mint lands.
- Mint landed, Flutterwave credit not seen: do not re-burn. Reconcile
  by Polygon mint hash and wallet address with Flutterwave support.
  Funds sit as Polygon USDC in the Flutterwave wallet once credited;
  they are not lost, only unconverted.
- Credit seen, conversion fails: the USDC stays in the Flutterwave
  wallet. Retry conversion only after a status check shows the first
  attempt did not convert. If conversion is impossible, the exit is an
  outbound stablecoin transfer from Flutterwave (listed at $1.5 flat
  plus network gas) back to an Oruva-controlled wallet, approved by
  the founder before it is sent.
- Conversion done, NGN transfer fails: the NGN sits in the Flutterwave
  balance. Re-initiate the transfer only after a status check shows no
  transfer was sent. The payout record stays in `pending_payout`.
- Any ambiguous state: freeze the payout in `failed-reconcile`,
  reconcile by hashes and references, and decide from evidence. No
  blind retries at any step. Every resume starts from the recorded
  state and hashes.

### Success evidence to record

- Payout ID, test amount, and founder approval of both.
- Stellar burn transaction hash and explorer link.
- CCTP attestation completion and Polygon `forwardTxHash`.
- Flutterwave credit evidence (dashboard or API status) matching the
  mint recipient address.
- Conversion quote and actuals: Flutterwave rate, displayed rate,
  gross NGN, fee charged, final NGN credit, conversion reference.
- Flutterwave transfer reference and the Paystack DVA credit
  reference, with the credited amount.
- Timestamps for every state change, and the reconciliation result
  (chain complete, no breaks).
- The fee basis conclusion drawn from the actual fee charged.

### The live rule

Live NGN payout is not called live, in the app, in docs, or in any
submission, until this test passes end to end and the evidence above
is recorded. A passed test on the founder's account proves the rail;
user-facing rollout is a separate founder decision after the test.

## Founder-only steps, collected

1. Flutterwave dashboard screenshot of the stablecoin section
   (section 1).
2. Submit the stablecoin application form if the dashboard offers one
   (section 1).
3. Approve the exact support-request text if no dashboard route exists
   (section 1).
4. Railway dashboard screenshot of static outbound IP availability and
   cost (section 2).
5. Approve or decline the static egress cost (section 2).
6. Paste the confirmed static IP into the Flutterwave whitelist
   (section 2).
7. Copy the Polygon USDC deposit address from the Flutterwave
   dashboard and send it to David (section 3).
8. Paste `CCTP_MINT_RECIPIENT` into Railway configuration with the
   value David states (section 3).
9. Approve the exact fee-basis question text to Flutterwave
   (section 4).
10. Confirm expected stablecoin volume figures (section 5).
11. Confirm co-founder document readiness if Flutterwave asks
    (section 5).
12. Confirm settlement account details in the Flutterwave dashboard if
    asked (section 5).
13. Approve the exact live-test amount and test user (section 6).

## Facts not verified in this pack

- Flutterwave's exact stablecoin approval requirements for this
  account (document list, limits, settlement terms). Owed by
  Flutterwave in writing.
- Account-level enablement of Polygon inbound stablecoin funding.
  Assumed from Flutterwave's published network list only.
- Live-mode activation state of the account for stablecoin payouts.
- Railway static outbound IP availability and cost on Oruva's plan.
- Whether Flutterwave requires its own confirmed settlement bank
  account for the stablecoin product.
- The 1.5% fee basis (gross value vs presented amount), pending the
  written answer or the live quote evidence.
- Paystack DVA receiving for converted NGN, pending Paystack's reply
  demanded by 30 November 2026.
