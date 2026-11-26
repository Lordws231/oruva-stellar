# Oruva Stellar backend

Node service layer for the Stellar testnet build.

## Built

- Default Stellar wallet provisioning for riders and drivers.
- Wallet activation before external deposits.
- Deposit instructions for a user's default wallet and for an Oruva omnibus
  address with an `ORUVA:<userId>` memo.
- External deposit crediting with payment-id idempotency.
- Horizon payment sync for a default wallet.
- Driver payout preferences: external Stellar wallet, USDC, eNaira, or
  local bank.
- Withdrawal split: Oruva keeps exactly 10%; the driver is recorded as the
  Stellar fee payer for the withdrawal transaction.
- Conversion quotes through a rate-provider interface, including a Horizon
  path provider for Stellar asset conversion.
- eNaira and bank payout adapters. The testnet build uses simulated
  adapters; live payout requires partner credentials and funded settlement
  accounts.

## Tests

```sh
npm test
```

## Production notes

- Store wallet secret keys only after KMS encryption. Never log them.
- Replace the in-memory store with the platform database.
- Replace simulated payout adapters with the confirmed live partner adapter
  after credentials, settlement funding, and licensing checks are complete.
