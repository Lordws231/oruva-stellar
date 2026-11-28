#!/usr/bin/env bash
# Oruva Intents testnet demo.
# Deploys oruva-intents, settles one Stellar USDC intent through a
# registered solver, then refunds a second intent after its deadline.
# Testnet only. Prints contract ID and transaction hashes.
set -euo pipefail
cd "$(dirname "$0")/.."

export STELLAR_RPC_URL="${STELLAR_RPC_URL:-http://127.0.0.1:8765}"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

USDC_SAC="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"

invoke() {
  local label="$1"; shift
  echo "== $label =="
  local out
  out="$(stellar contract invoke "$@" 2>&1)"
  echo "$out"
  local hash
  hash="$(printf '%s' "$out" | grep -oE '[0-9a-f]{64}' | head -n 1 || true)"
  if [ -n "$hash" ]; then
    echo "TX $label: $hash"
    echo "   https://stellar.expert/explorer/testnet/tx/$hash"
  fi
}

latest_ledger() {
  curl -s -X POST "$STELLAR_RPC_URL" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sequence'])"
}

echo "== build contract =="
stellar contract build --package oruva-intents

ADMIN="$(stellar keys address issuer)"
RIDER="$(stellar keys address rider)"
DRIVER="$(stellar keys address driver)"
SOLVER="$(stellar keys address external-driver-wallet)"

echo "== deploy oruva-intents =="
DEPLOY_OUT="$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/oruva_intents.wasm \
  --source-account issuer \
  --alias oruva-intents 2>&1)"
echo "$DEPLOY_OUT"
CONTRACT_ID="$(printf '%s' "$DEPLOY_OUT" | grep -oE 'C[A-Z2-7]{55}' | tail -n 1)"
echo "$CONTRACT_ID" > deployed-intents-contract.txt
echo "CONTRACT: $CONTRACT_ID"
echo "   https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"

invoke "init" --id "$CONTRACT_ID" --source-account issuer -- \
  init --admin "$ADMIN"

invoke "register solver" --id "$CONTRACT_ID" --source-account external-driver-wallet -- \
  register-solver --solver "$SOLVER" --bond-asset "$USDC_SAC" --bond-amount 10000000

DEADLINE=$(( $(latest_ledger) + 200 ))
invoke "create intent-001" --id "$CONTRACT_ID" --source-account rider -- \
  create-intent --user "$RIDER" --intent-hash "intent-001" \
  --input-asset "$USDC_SAC" --input-amount 3000000 \
  --min-output-amount 2700000 --output-asset "$USDC_SAC" \
  --output-chain "stellar" --recipient "$DRIVER" \
  --deadline-ledger "$DEADLINE" --kind SwapConvert

invoke "claim intent-001" --id "$CONTRACT_ID" --source-account external-driver-wallet -- \
  claim-intent --solver "$SOLVER" --intent-hash "intent-001"

invoke "fill intent-001" --id "$CONTRACT_ID" --source-account external-driver-wallet -- \
  fill-intent --solver "$SOLVER" --intent-hash "intent-001" \
  --delivered-amount 2800000 --recipient "$DRIVER" \
  --evidence-ref "demo:stellar-fill-001"

invoke "get intent-001" --id "$CONTRACT_ID" --source-account rider -- \
  get-intent --intent-hash "intent-001"

SHORT_DEADLINE=$(( $(latest_ledger) + 20 ))
invoke "create intent-002" --id "$CONTRACT_ID" --source-account rider -- \
  create-intent --user "$RIDER" --intent-hash "intent-002" \
  --input-asset "$USDC_SAC" --input-amount 500000 \
  --min-output-amount 450000 --output-asset "$USDC_SAC" \
  --output-chain "stellar" --recipient "$DRIVER" \
  --deadline-ledger "$SHORT_DEADLINE" --kind SwapConvert

echo "== waiting for intent-002 deadline ledger $SHORT_DEADLINE =="
while [ "$(latest_ledger)" -le "$SHORT_DEADLINE" ]; do sleep 3; done

invoke "refund intent-002" --id "$CONTRACT_ID" --source-account rider -- \
  refund-intent --user "$RIDER" --intent-hash "intent-002"

invoke "get intent-002" --id "$CONTRACT_ID" --source-account rider -- \
  get-intent --intent-hash "intent-002"

invoke "slash solver bond" --id "$CONTRACT_ID" --source-account issuer -- \
  record-penalty --solver "$SOLVER" --intent-hash "intent-002" \
  --reason "demo slash after refund" --slash-amount 2000000

invoke "get solver" --id "$CONTRACT_ID" --source-account rider -- \
  get-solver --solver "$SOLVER"

echo "contract: https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
