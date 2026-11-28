import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STELLAR_NETWORKS,
  explorerContractUrl,
  explorerTxUrl,
  getNetworkConfig,
  networkEnvBlock,
  resolveNetwork,
} from '../src/network.js';

test('testnet is the default and carries the verified intents contract', () => {
  const config = resolveNetwork({});
  assert.equal(config.name, 'testnet');
  assert.equal(config.liveMoney, false);
  assert.equal(config.passphrase, 'Test SDF Network ; September 2015');
  assert.equal(
    config.intentsContractId,
    'CAXOQEOG2UVT5DJZF76NMBIZRPPVIQOKPQTBP67OTYMV2MGED7AMJU6X',
  );
});

test('testnet and mainnet share one config shape for parity', () => {
  const testnetKeys = Object.keys(STELLAR_NETWORKS.testnet).sort();
  const mainnetKeys = Object.keys(STELLAR_NETWORKS.mainnet).sort();
  assert.deepEqual(mainnetKeys, testnetKeys);
  assert.equal(STELLAR_NETWORKS.mainnet.passphrase, 'Public Global Stellar Network ; September 2015');
  assert.notEqual(STELLAR_NETWORKS.mainnet.usdcIssuer, STELLAR_NETWORKS.testnet.usdcIssuer);
});

test('mainnet refuses to resolve until gates and contract are set', () => {
  assert.throws(
    () => resolveNetwork({ ORUVA_STELLAR_NETWORK: 'mainnet' }),
    /mainnet is gated.*ORUVA_MAINNET_AUTHORIZED.*ORUVA_MAINNET_GATES_CLEARED.*ORUVA_INTENTS_CONTRACT_ID/s,
  );
  assert.throws(
    () => resolveNetwork({
      ORUVA_STELLAR_NETWORK: 'mainnet',
      ORUVA_MAINNET_AUTHORIZED: 'true',
      ORUVA_MAINNET_GATES_CLEARED: 'true',
    }),
    /ORUVA_INTENTS_CONTRACT_ID/,
  );
});

test('mainnet resolves with gates cleared and switches every endpoint', () => {
  const config = resolveNetwork({
    ORUVA_STELLAR_NETWORK: 'mainnet',
    ORUVA_MAINNET_AUTHORIZED: 'true',
    ORUVA_MAINNET_GATES_CLEARED: 'true',
    ORUVA_INTENTS_CONTRACT_ID: 'CMAINNETCONTRACT',
  });
  assert.equal(config.liveMoney, true);
  assert.equal(config.horizonUrl, 'https://horizon.stellar.org');
  assert.equal(
    explorerContractUrl(config),
    'https://stellar.expert/explorer/public/contract/CMAINNETCONTRACT',
  );
  assert.equal(
    explorerTxUrl(config, 'abc123'),
    'https://stellar.expert/explorer/public/tx/abc123',
  );
  assert.match(networkEnvBlock(config), /ORUVA_STELLAR_NETWORK=mainnet/);
});

test('env overrides win and unknown networks fail', () => {
  const config = resolveNetwork({
    ORUVA_HORIZON_URL: 'https://horizon.example.test/',
    ORUVA_USDC_ISSUER: 'GOVERRIDE',
  });
  assert.equal(config.horizonUrl, 'https://horizon.example.test');
  assert.equal(config.usdcIssuer, 'GOVERRIDE');
  assert.throws(() => getNetworkConfig('futurenet'), /unknown Stellar network/);
});
