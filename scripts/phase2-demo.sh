#!/usr/bin/env bash
# Oruva Stellar phase 2 demo on testnet.
#
# Deploys a fresh escrow instance with driver balances and withdrawals, then
# verifies:
#   1. rider locks a 5 USDC fare
#   2. admin releases it into the driver's withdrawable balance
#   3. driver withdraws 5 USDC to an external wallet
#   4. Oruva treasury receives 0.5 USDC and the external wallet receives
#      4.5 USDC; the driver submits the withdrawal transaction and pays its
#      Stellar fee
#
# Prerequisites: RPC proxy running, identities issuer/rider/driver present,
# rider funded with testnet USDC.
set -euo pipefail
cd "$(dirname "$0")/.."

export STELLAR_RPC_URL="${STELLAR_RPC_URL:-http://127.0.0.1:8765}"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

USDC_ISSUER="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
USDC_SAC="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
FARE=50000000 # 5 USDC, 7 decimals
RIDE_ID="phase2-ride-001"

ensure_identity() {
  local name="$1"
  if ! stellar keys address "$name" >/dev/null 2>&1; then
    stellar keys generate "$name" --fund >/dev/null
  fi
  stellar keys address "$name"
}

balance_usdc() {
  curl -s "https://horizon-testnet.stellar.org/accounts/$1" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(next((b['balance'] for b in d.get('balances',[]) if b.get('asset_code')=='USDC'), '0'))"
}

echo "== build contract =="
stellar contract build --package oruva-escrow

ADMIN="$(stellar keys address issuer)"
RIDER="$(stellar keys address rider)"
DRIVER="$(stellar keys address driver)"
TREASURY="$(ensure_identity treasury)"
EXTERNAL="$(ensure_identity external-driver-wallet)"

echo "== ensure USDC trustlines =="
stellar tx new change-trust --source-account treasury --line "USDC:$USDC_ISSUER" >/dev/null
stellar tx new change-trust --source-account external-driver-wallet --line "USDC:$USDC_ISSUER" >/dev/null

echo "== deploy fresh phase 2 contract =="
CONTRACT_ID="$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/oruva_escrow.wasm \
  --source-account issuer \
  --alias oruva-escrow-phase2 | tail -n 1)"
echo "$CONTRACT_ID" > deployed-phase2-contract.txt

echo "== init =="
stellar contract invoke --id "$CONTRACT_ID" --source-account issuer -- \
  init --admin "$ADMIN" --token "$USDC_SAC" --treasury "$TREASURY"

echo "== balances before =="
echo "rider USDC: $(balance_usdc "$RIDER")"
echo "treasury USDC: $(balance_usdc "$TREASURY")"
echo "external USDC: $(balance_usdc "$EXTERNAL")"

echo "== lock fare =="
stellar contract invoke --id "$CONTRACT_ID" --source-account rider -- \
  lock_fare --rider "$RIDER" --driver "$DRIVER" --amount "$FARE" --ride-id "$RIDE_ID"

echo "== release to driver balance =="
stellar contract invoke --id "$CONTRACT_ID" --source-account issuer -- \
  release_fare --ride-id "$RIDE_ID"

echo "== driver balance =="
stellar contract invoke --id "$CONTRACT_ID" --source-account driver -- \
  get_driver_balance --driver "$DRIVER"

echo "== driver withdraws to external wallet =="
stellar contract invoke --id "$CONTRACT_ID" --source-account driver -- \
  withdraw --driver "$DRIVER" --destination "$EXTERNAL" --amount "$FARE"

echo "== driver balance after withdrawal =="
stellar contract invoke --id "$CONTRACT_ID" --source-account driver -- \
  get_driver_balance --driver "$DRIVER"

echo "== balances after =="
echo "rider USDC: $(balance_usdc "$RIDER")"
echo "treasury USDC: $(balance_usdc "$TREASURY")"
echo "external USDC: $(balance_usdc "$EXTERNAL")"
echo "contract: https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
