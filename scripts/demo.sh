#!/usr/bin/env bash
# Oruva fare-escrow demo on Stellar testnet.
#
# Runs the full ride-settlement flow against the deployed oruva-escrow
# contract:
#   1. rider locks a 25 TUSD fare for ride-001
#   2. get_ride shows the ride Locked
#   3. driver confirms arrival with a proof reference, passenger
#      authorizes the release, then the fare is released (dual
#      confirmation; the admin cannot release alone)
#   4. get_ride shows the ride Released; driver holds the fare
#
# Prerequisites:
#   - the local RPC proxy running (python3 tools/rpc-proxy.py)
#   - the contract deployed; its id in deployed-contract.txt
#   - identities issuer / rider / driver in the Stellar CLI key store
#   - the rider funded with TUSD (see README)
#
# Testnet only. No real funds.
set -euo pipefail
cd "$(dirname "$0")/.."

export STELLAR_RPC_URL="${STELLAR_RPC_URL:-http://127.0.0.1:8765}"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

CONTRACT_ID="$(cat deployed-contract.txt)"
RIDER="$(stellar keys address rider)"
DRIVER="$(stellar keys address driver)"
FARE=250000000  # 25 TUSD in smallest units (7 decimals)
RIDE_ID="ride-001"

balance() {
  curl -s "https://horizon-testnet.stellar.org/accounts/$1" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print({b.get('asset_code', 'XLM'): b['balance'] for b in d['balances']})"
}

echo "== contract: $CONTRACT_ID"
echo "== rider:    $RIDER"
echo "== driver:   $DRIVER"
echo
echo "== balances before =="
echo -n "rider:  "; balance "$RIDER"
echo -n "driver: "; balance "$DRIVER"

echo
echo "== 1. rider locks a 25 TUSD fare for $RIDE_ID =="
stellar contract invoke --id "$CONTRACT_ID" --source-account rider -- \
  lock_fare --rider "$RIDER" --driver "$DRIVER" --amount "$FARE" --ride-id "$RIDE_ID"

echo
echo "== 2. ride state after lock =="
stellar contract invoke --id "$CONTRACT_ID" --source-account rider -- \
  get_ride --ride-id "$RIDE_ID"

echo
echo "== 3. dual confirmation, then release =="
stellar contract invoke --id "$CONTRACT_ID" --source-account driver -- \
  confirm_arrival --driver "$DRIVER" --ride-id "$RIDE_ID" \
  --proof-ref "proof:demo-arrival-001"
stellar contract invoke --id "$CONTRACT_ID" --source-account rider -- \
  authorize_release --rider "$RIDER" --ride-id "$RIDE_ID"
stellar contract invoke --id "$CONTRACT_ID" --source-account issuer -- \
  release_fare --ride-id "$RIDE_ID"

echo
echo "== 4. ride state after release =="
stellar contract invoke --id "$CONTRACT_ID" --source-account rider -- \
  get_ride --ride-id "$RIDE_ID"

echo
echo "== balances after =="
echo -n "rider:  "; balance "$RIDER"
echo -n "driver: "; balance "$DRIVER"
echo
echo "Demo complete. Verify on Stellar Expert (testnet):"
echo "  https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
