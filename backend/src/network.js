// Stellar network parity configuration.
//
// Testnet and mainnet run the exact same contract code and backend
// paths. Only configuration changes: network passphrase, Horizon and
// Soroban RPC endpoints, asset issuers, explorer base and contract
// IDs. Testnet is the default. Mainnet refuses to resolve until the
// production gates are explicitly marked cleared and the founder
// mainnet authorization flag is set, so a stray env change can
// never point the system at live money by accident.

export const TESTNET_INTENTS_CONTRACT_ID =
  'CAXOQEOG2UVT5DJZF76NMBIZRPPVIQOKPQTBP67OTYMV2MGED7AMJU6X';

export const STELLAR_NETWORKS = Object.freeze({
  testnet: Object.freeze({
    name: 'testnet',
    passphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    explorerBase: 'https://stellar.expert/explorer/testnet',
    friendbotUrl: 'https://friendbot.stellar.org',
    usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    intentsContractId: TESTNET_INTENTS_CONTRACT_ID,
    liveMoney: false,
  }),
  mainnet: Object.freeze({
    name: 'mainnet',
    passphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-rpc.stellar.org',
    explorerBase: 'https://stellar.expert/explorer/public',
    friendbotUrl: null,
    usdcIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    intentsContractId: null,
    liveMoney: true,
  }),
});

export const MAINNET_GATE_FLAGS = Object.freeze([
  'ORUVA_MAINNET_AUTHORIZED',
  'ORUVA_MAINNET_GATES_CLEARED',
]);

function envFlag(env, name) {
  return String(env[name] ?? '').trim().toLowerCase() === 'true';
}

function cleanUrl(value, fallback) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
  return raw.replace(/\/$/, '');
}

export function getNetworkConfig(name = 'testnet') {
  const key = String(name ?? '').trim().toLowerCase();
  const config = STELLAR_NETWORKS[key];
  if (!config) {
    throw new Error(`unknown Stellar network: ${name}`);
  }
  return config;
}

export function resolveNetwork(env = {}) {
  const base = getNetworkConfig(env.ORUVA_STELLAR_NETWORK ?? 'testnet');
  const config = {
    ...base,
    horizonUrl: cleanUrl(env.ORUVA_HORIZON_URL, base.horizonUrl),
    sorobanRpcUrl: cleanUrl(env.ORUVA_SOROBAN_RPC_URL, base.sorobanRpcUrl),
    usdcIssuer: env.ORUVA_USDC_ISSUER?.trim() || base.usdcIssuer,
    intentsContractId: env.ORUVA_INTENTS_CONTRACT_ID?.trim() || base.intentsContractId,
  };
  if (config.name === 'mainnet') {
    const missing = MAINNET_GATE_FLAGS.filter((flag) => !envFlag(env, flag));
    if (!config.intentsContractId) missing.push('ORUVA_INTENTS_CONTRACT_ID');
    if (missing.length > 0) {
      throw new Error(
        `mainnet is gated, missing: ${missing.join(', ')}. `
        + 'Mainnet requires custody validation, SEC/VASP legal clearance, '
        + 'an independent penetration test and founder mainnet authorization.',
      );
    }
  }
  return Object.freeze(config);
}

export function explorerContractUrl(config, contractId = config.intentsContractId) {
  if (!contractId) throw new Error('contractId is required');
  return `${config.explorerBase}/contract/${contractId}`;
}

export function explorerTxUrl(config, txHash) {
  if (!txHash) throw new Error('txHash is required');
  return `${config.explorerBase}/tx/${txHash}`;
}

export function networkEnvBlock(config) {
  return [
    `ORUVA_STELLAR_NETWORK=${config.name}`,
    `ORUVA_HORIZON_URL=${config.horizonUrl}`,
    `ORUVA_SOROBAN_RPC_URL=${config.sorobanRpcUrl}`,
    `ORUVA_USDC_ISSUER=${config.usdcIssuer}`,
    `ORUVA_INTENTS_CONTRACT_ID=${config.intentsContractId ?? ''}`,
  ].join('\n');
}
