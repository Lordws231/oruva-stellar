#!/usr/bin/env bash
# Oruva dual-confirmation escrow verification on Stellar testnet.
#
# Deploys a fresh escrow instance with dual-confirmation release, then
# verifies:
#   1. rider locks a 2 USDC fare for dual-ride-001
#   2. driver confirms arrival with a proof reference
#   3. release with only the driver proof is rejected on-chain
#   4. passenger authorizes the release
#   5. release credits the driver's withdrawable balance
#   6. rider locks a 1 USDC fare for dual-ride-002, admin refunds it
#   7. driver withdraws 2 USDC: 90% to the external wallet, 10% to
#      treasury; the driver submits and pays the Stellar fee
#
# Prints every transaction hash for the evidence file. Testnet only.
set -euo pipefail
cd "$(dirname "$0")/.."

export STELLAR_RPC_URL="${STELLAR_RPC_URL:-http://127.0.0.1:8765}"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

USDC_SAC="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
FARE1=20000000 # 2 USDC, 7 decimals
FARE2=10000000 # 1 USDC

balance_usdc() {
  curl -s "https://horizon-testnet.stellar.org/accounts/$1" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(next((b['balance'] for b in d.get('balances',[]) if b.get('asset_code')=='USDC'), '0'))"
}

# Run an invoke, echo its output, and print the transaction hash if the
# CLI reports one.
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

echo "== build contract =="
stellar contract build --package oruva-escrow

ADMIN="$(stellar keys address issuer)"
RIDER="$(stellar keys address rider)"
DRIVER="$(stellar keys address driver)"
TREASURY="$(stellar keys address treasury)"
EXTERNAL="$(stellar keys address external-driver-wallet)"

echo "== deploy fresh dual-confirmation contract =="
DEPLOY_OUT="$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/oruva_escrow.wasm \
  --source-account issuer \
  --alias oruva-escrow-dual 2>&1)"
echo "$DEPLOY_OUT"
CONTRACT_ID="$(printf '%s' "$DEPLOY_OUT" | grep -oE 'C[A-Z2-7]{55}' | tail -n 1)"
echo "$CONTRACT_ID" > deployed-dual-contract.txt
echo "CONTRACT: $CONTRACT_ID"
echo "   https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"

invoke "init" --id "$CONTRACT_ID" --source-account issuer -- \
  init --admin "$ADMIN" --token "$USDC_SAC" --treasury "$TREASURY"

echo "== balances before =="
echo "rider USDC: $(balance_usdc "$RIDER")"
echo "treasury USDC: $(balance_usdc "$TREASURY")"
echo "external USDC: $(balance_usdc "$EXTERNAL")"

invoke "lock dual-ride-001" --id "$CONTRACT_ID" --source-account rider -- \
  lock_fare --rider "$RIDER" --driver "$DRIVER" --amount "$FARE1" \
  --ride-id "dual-ride-001"

invoke "driver confirms arrival" --id "$CONTRACT_ID" --source-account driver -- \
  confirm_arrival --driver "$DRIVER" --ride-id "dual-ride-001" \
  --proof-ref "proof:dual-arrival-001"

echo "== release with only the driver proof (must be rejected) =="
if stellar contract invoke --id "$CONTRACT_ID" --source-account issuer -- \
  release_fare --ride-id "dual-ride-001" 2>&1; then
  echo "UNEXPECTED: release succeeded with only one confirmation"
  exit 1
else
  echo "Rejected as expected: passenger authorization is still missing."
fi

invoke "passenger authorizes release" --id "$CONTRACT_ID" --source-account rider -- \
  authorize_release --rider "$RIDER" --ride-id "dual-ride-001"

invoke "release dual-ride-001" --id "$CONTRACT_ID" --source-account issuer -- \
  release_fare --ride-id "dual-ride-001"

invoke "get_ride dual-ride-001" --id "$CONTRACT_ID" --source-account rider -- \
  get_ride --ride-id "dual-ride-001"

invoke "driver balance after release" --id "$CONTRACT_ID" --source-account driver -- \
  get_driver_balance --driver "$DRIVER"

invoke "lock dual-ride-002" --id "$CONTRACT_ID" --source-account rider -- \
  lock_fare --rider "$RIDER" --driver "$DRIVER" --amount "$FARE2" \
  --ride-id "dual-ride-002"

invoke "refund dual-ride-002" --id "$CONTRACT_ID" --source-account issuer -- \
  refund_fare --ride-id "dual-ride-002"

invoke "driver withdraws 2 USDC" --id "$CONTRACT_ID" --source-account driver -- \
  withdraw --driver "$DRIVER" --destination "$EXTERNAL" --amount "$FARE1"

invoke "driver balance after withdrawal" --id "$CONTRACT_ID" --source-account driver -- \
  get_driver_balance --driver "$DRIVER"

echo "== balances after =="
echo "rider USDC: $(balance_usdc "$RIDER")"
echo "treasury USDC: $(balance_usdc "$TREASURY")"
echo "external USDC: $(balance_usdc "$EXTERNAL")"
echo "contract: https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
