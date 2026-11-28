#!/usr/bin/env bash
# Deploy the Oruva Intents contract to testnet or mainnet.
#
# The same contract code and deploy steps run on both networks.
# Only configuration changes. Testnet is the default. Mainnet
# refuses to run until the production gates are marked cleared,
# the founder authorization flag is set, and the operator passes
# CONFIRM_MAINNET_DEPLOY=deploy-mainnet.
#
# Usage:
#   NETWORK=testnet SOURCE_ACCOUNT=<identity> ./scripts/deploy-intents.sh
#   NETWORK=mainnet SOURCE_ACCOUNT=<identity> ./scripts/deploy-intents.sh --dry-run
set -euo pipefail

NETWORK="${NETWORK:-testnet}"
SOURCE_ACCOUNT="${SOURCE_ACCOUNT:-}"
DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

case "$NETWORK" in
  testnet)
    PASSPHRASE="Test SDF Network ; September 2015"
    RPC_URL="${ORUVA_SOROBAN_RPC_URL:-https://soroban-testnet.stellar.org}"
    EXPLORER="https://stellar.expert/explorer/testnet"
    ;;
  mainnet)
    PASSPHRASE="Public Global Stellar Network ; September 2015"
    RPC_URL="${ORUVA_SOROBAN_RPC_URL:-https://soroban-rpc.stellar.org}"
    EXPLORER="https://stellar.expert/explorer/public"
    if [ "${ORUVA_MAINNET_AUTHORIZED:-}" != "true" ] \
      || [ "${ORUVA_MAINNET_GATES_CLEARED:-}" != "true" ] \
      || [ "${CONFIRM_MAINNET_DEPLOY:-}" != "deploy-mainnet" ]; then
      echo "Mainnet deploy blocked." >&2
      echo "Required: ORUVA_MAINNET_AUTHORIZED=true, ORUVA_MAINNET_GATES_CLEARED=true," >&2
      echo "and CONFIRM_MAINNET_DEPLOY=deploy-mainnet." >&2
      echo "Gates: custody validation, SEC/VASP legal clearance, independent" >&2
      echo "penetration test, founder mainnet authorization." >&2
      exit 1
    fi
    ;;
  *)
    echo "Unknown NETWORK: $NETWORK (use testnet or mainnet)" >&2
    exit 1
    ;;
esac

if [ -z "$SOURCE_ACCOUNT" ]; then
  echo "SOURCE_ACCOUNT is required (a Stellar CLI identity name, never a secret key)" >&2
  exit 1
fi

echo "Network: $NETWORK"
echo "RPC: $RPC_URL"
echo "Source identity: $SOURCE_ACCOUNT"

if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run. Commands that would run:"
  echo "  stellar contract build --package oruva-intents"
  echo "  stellar contract deploy --wasm target/wasm32v1-none/release/oruva_intents.wasm \\"
  echo "    --source-account $SOURCE_ACCOUNT --network $NETWORK --alias oruva-intents-$NETWORK"
  exit 0
fi

stellar contract build --package oruva-intents

CONTRACT_ID="$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/oruva_intents.wasm \
  --source-account "$SOURCE_ACCOUNT" \
  --network "$NETWORK" \
  --alias "oruva-intents-$NETWORK")"

echo "Contract: $CONTRACT_ID"
echo "Explorer: $EXPLORER/contract/$CONTRACT_ID"
echo "Set these env values for the backend:"
echo "ORUVA_STELLAR_NETWORK=$NETWORK"
echo "ORUVA_INTENTS_CONTRACT_ID=$CONTRACT_ID"
echo "Next: init the contract, register solvers with bonds, run the smoke"
echo "checks in docs/mainnet-switch.md before sending traffic."
