# Testnet to Mainnet Switch Runbook

Oruva Intents runs the same contract code and backend paths on testnet and mainnet. The switch changes configuration only: network passphrase, Horizon and Soroban RPC endpoints, asset issuers, explorer base and contract IDs. `backend/src/network.js` is the single source of that configuration, and testnet is the default.

## Parity rules

- One code path: `resolveNetwork(env)` returns the same config shape for both networks. No testnet-only branches in contract or backend logic.
- One deploy path: `scripts/deploy-intents.sh` builds and deploys identically, selected by `NETWORK`.
- The Tester API and sandbox always stay on testnet, even after mainnet launch. Developers keep a safe place to test.
- Mainnet refuses to resolve until the gates below are explicitly marked cleared. A stray env change cannot point the system at live money.

## Configuration

| Env value | Testnet | Mainnet |
| --- | --- | --- |
| `ORUVA_STELLAR_NETWORK` | `testnet` | `mainnet` |
| `ORUVA_HORIZON_URL` | horizon-testnet.stellar.org | horizon.stellar.org |
| `ORUVA_SOROBAN_RPC_URL` | soroban-testnet.stellar.org | soroban-rpc.stellar.org |
| `ORUVA_USDC_ISSUER` | testnet USDC issuer | Circle mainnet USDC issuer |
| `ORUVA_INTENTS_CONTRACT_ID` | verified testnet instance | set after mainnet deploy |
| `ORUVA_MAINNET_AUTHORIZED` | not needed | must be `true` |
| `ORUVA_MAINNET_GATES_CLEARED` | not needed | must be `true` |

Defaults live in `backend/src/network.js`; env values override endpoints and issuers when a deployment needs its own RPC provider.

## Gates before any mainnet switch

All of these must be true, with evidence on file:

1. Custody validated with the chosen provider, including allowlists, limits and emergency freeze.
2. Written SEC/VASP legal clearance for the exact mainnet activities.
3. Independent penetration test completed with critical findings closed.
4. Partner gates for any live fiat leg confirmed in writing.
5. Founder mainnet authorization given expressly for this deployment.

Only then set `ORUVA_MAINNET_GATES_CLEARED=true` and `ORUVA_MAINNET_AUTHORIZED=true`.

## Switch steps

1. Deploy: `NETWORK=mainnet SOURCE_ACCOUNT=<identity> CONFIRM_MAINNET_DEPLOY=deploy-mainnet ./scripts/deploy-intents.sh`. Use `--dry-run` first to review the commands.
2. Init the contract and register solvers with real bonds from custody-controlled accounts.
3. Set the env block the deploy script prints, plus the two gate flags.
4. Smoke checks with small capped amounts: quote, submit, settle, refund after deadline, bond slash path on a test solver, explorer links resolve on the public explorer.
5. Watch solver fill rates, penalties and evidence packs before raising caps.

## Rollback

Set `ORUVA_STELLAR_NETWORK=testnet` and restart. Traffic returns to the testnet configuration immediately. The mainnet contract keeps its state and can be inspected, but no new mainnet intents are accepted while the backend points at testnet.
