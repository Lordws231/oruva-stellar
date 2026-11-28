// Oruva Intents Tester API and sandbox.
//
// A testnet-only surface that lets other developers use and test
// Oruva Intents without touching live money. Developers issue
// their own sandbox keys, run capped quote, submit, status, refund
// and simulated-fill flows, and reset their sandbox state. Every
// record is isolated per API key. Settlement here is simulated:
// no real funds move and no mainnet path exists in this module.

import { randomUUID } from 'node:crypto';
import { API_KEY_SCOPES, ApiKeyStore } from './apiKeys.js';
import {
  ApiKeyRateLimiter,
  CctpRouteAdapter,
  IntentService,
  StellarDexRouteAdapter,
} from './intents.js';
import { createSwapApi } from './swapApi.js';

export const TESTER_NETWORK = 'stellar-testnet';
export const TESTER_DEFAULT_MAX_INPUT_AMOUNT = 10;
export const MASTER_URL = 'https://intents.oruva.com.ng/tester';

export const TESTER_API_ROUTES = Object.freeze([
  'GET /tester/v1/health',
  'POST /tester/v1/register',
  'POST /tester/v1/signin',
  'POST /tester/v1/account/keys',
  'GET /tester/v1/account/keys',
  'POST /tester/v1/account/keys/:keyId/revoke',
  'POST /tester/v1/account/keys/delete',
  'POST /tester/v1/keys',
  'POST /tester/v1/intents/quote',
  'POST /tester/v1/intents/submit',
  'GET /tester/v1/intents/:intentId',
  'POST /tester/v1/intents/:intentId/refund',
  'POST /tester/v1/intents/:intentId/simulate-fill',
  'POST /tester/v1/reset',
  'GET /tester/v1/tokens',
  'POST /tester/v1/swap/quote',
  'POST /tester/v1/swap/deposit/submit',
  'GET /tester/v1/swap/status',
  'POST /tester/v1/swap/generate-intent',
  'POST /tester/v1/swap/submit-intent',
  'POST /tester/v1/swap/orders',
  'GET /tester/v1/swap/orders',
  'GET /tester/v1/swap/orders/:orderId',
  'POST /tester/v1/swap/orders/:orderId/fund',
  'POST /tester/v1/swap/orders/:orderId/simulate-fill',
  'POST /tester/v1/swap/orders/:orderId/cancel',
  'GET /tester/v1/swap/balances',
]);

const TESTER_SCOPES = Object.freeze([
  API_KEY_SCOPES.QUOTE,
  API_KEY_SCOPES.SUBMIT,
  API_KEY_SCOPES.STATUS,
  API_KEY_SCOPES.REFUND,
]);

function requireLabel(label) {
  if (typeof label !== 'string' || label.trim() === '') {
    throw new Error('label is required');
  }
  const clean = label.trim();
  if (clean.length > 80) throw new Error('label must be 80 characters or fewer');
  return clean;
}

function apiKeyFrom(headers = {}) {
  return headers['x-api-key'] ?? headers['X-Api-Key'];
}

export function createSandboxIntentService() {
  return new IntentService({
    routeAdapters: [new StellarDexRouteAdapter(), new CctpRouteAdapter()],
  });
}

export function createTesterApi({
  service = createSandboxIntentService(),
  apiKeyStore = new ApiKeyStore(),
  rateLimiter = new ApiKeyRateLimiter({ limit: 60, windowMs: 60000 }),
  keyIssueLimiter = new ApiKeyRateLimiter({ limit: 5, windowMs: 3600000 }),
  maxInputAmount = TESTER_DEFAULT_MAX_INPUT_AMOUNT,
} = {}) {
  const swapApi = createSwapApi({ maxWholeUnits: maxInputAmount });
  const quoteOwners = new Map();
  const intentOwners = new Map();
  const accounts = new Map();
  const accountsByEmail = new Map();
  const keyAccounts = new Map();

  function requireEmail(email) {
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      throw new Error('a valid email is required');
    }
    return email.trim().toLowerCase();
  }

  function publicAccount(account) {
    return {
      masterId: account.masterId,
      masterUrl: MASTER_URL,
      name: account.name,
      businessName: account.businessName ?? account.name,
      masterKeyName: account.businessName ?? account.name,
      email: account.email,
      createdAt: account.createdAt,
      termsAcceptedAt: account.termsAcceptedAt,
    };
  }

  function authorize(headers, scope) {
    const verified = apiKeyStore.assertKey(apiKeyFrom(headers), scope, {
      requireSandbox: true,
    });
    rateLimiter.check(verified.keyId);
    const masterId = keyAccounts.get(verified.keyId) ?? verified.keyId;
    const account = accounts.get(masterId);
    return {
      ...verified,
      masterId,
      isMaster: Boolean(account && account.keyId === verified.keyId),
    };
  }

  function requireMaster(headers) {
    const verified = authorize(headers, null);
    if (!verified.isMaster) {
      throw new Error('master key required');
    }
    return { verified, account: accounts.get(verified.masterId) };
  }

  function ownedIntent(masterId, intentId) {
    if (intentOwners.get(intentId) !== masterId) {
      throw new Error('intent not found');
    }
    return service.status(intentId);
  }

  return {
    health() {
      return {
        ok: true,
        service: 'oruva-stellar-intents-tester',
        network: TESTER_NETWORK,
        mode: 'sandbox',
        liveMoney: false,
        masterUrl: MASTER_URL,
        maxInputAmount,
        routes: [...TESTER_API_ROUTES],
      };
    },

    register({ body = {} } = {}) {
      const name = requireLabel(body.businessName ?? body.name);
      const email = requireEmail(body.email);
      if (body.acceptTerms !== true) {
        throw new Error('terms acceptance is required');
      }
      if (accountsByEmail.has(email)) {
        throw new Error('email already registered, sign in instead');
      }
      keyIssueLimiter.check(`tester-register:${email}`);
      const { rawKey, record } = apiKeyStore.issueKey({
        scopes: [...TESTER_SCOPES],
        sandbox: true,
        label: name,
      });
      const now = new Date().toISOString();
      const account = {
        masterId: `oruva-dev-${randomUUID()}`,
        name,
        businessName: name,
        email,
        keyId: record.id,
        subKeyIds: [],
        createdAt: now,
        termsAcceptedAt: now,
      };
      accounts.set(account.masterId, account);
      accountsByEmail.set(email, account.masterId);
      keyAccounts.set(record.id, account.masterId);
      return {
        ...publicAccount(account),
        masterKey: rawKey,
        limits: {
          network: TESTER_NETWORK,
          liveMoney: false,
          maxInputAmount,
        },
      };
    },

    signIn({ body = {} } = {}) {
      const account = accounts.get(body.masterId);
      const rawKey = body.masterKey ?? body.apiKey;
      const verified = account
        ? apiKeyStore.verifyKey(rawKey, null, { requireSandbox: true })
        : { ok: false };
      if (!account || !verified.ok || verified.keyId !== account.keyId) {
        throw new Error('invalid master credentials');
      }
      return { ok: true, ...publicAccount(account) };
    },

    createSubKey({ headers, body = {} } = {}) {
      const { account } = requireMaster(headers);
      const label = requireLabel(body.idName ?? body.label);
      const taken = account.subKeyIds.some((keyId) => {
        const existing = apiKeyStore.getKey(keyId);
        return existing && existing.label.toLowerCase() === label.toLowerCase();
      });
      if (taken) throw new Error('id name already in use');
      const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes)] : [];
      if (scopes.length === 0 || scopes.some((scope) => !TESTER_SCOPES.includes(scope))) {
        throw new Error(`scopes must be a non-empty subset of: ${TESTER_SCOPES.join(', ')}`);
      }
      let expiresAt = null;
      if (body.expiresInMinutes != null) {
        const minutes = Number(body.expiresInMinutes);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 43200) {
          throw new Error('expiresInMinutes must be between 1 and 43200');
        }
        expiresAt = new Date(new Date(apiKeyStore.timestamp()).getTime() + minutes * 60000).toISOString();
      } else if (body.expiresAt != null) {
        const parsed = new Date(body.expiresAt);
        if (Number.isNaN(parsed.getTime()) || parsed <= new Date()) {
          throw new Error('expiresAt must be a future date');
        }
        expiresAt = parsed.toISOString();
      }
      const { rawKey, record } = apiKeyStore.issueKey({
        scopes,
        sandbox: true,
        label,
        expiresAt,
      });
      account.subKeyIds.push(record.id);
      keyAccounts.set(record.id, account.masterId);
      return { apiKey: rawKey, key: { ...record, kind: 'sub', masterId: account.masterId } };
    },

    listKeys({ headers } = {}) {
      const { account } = requireMaster(headers);
      const describe = (keyId, kind) => {
        const record = apiKeyStore.getKey(keyId);
        return record ? { ...record, kind, masterId: account.masterId } : null;
      };
      return {
        masterId: account.masterId,
        keys: [
          describe(account.keyId, 'master'),
          ...account.subKeyIds.map((keyId) => describe(keyId, 'sub')),
        ].filter(Boolean),
      };
    },

    deleteSubKey({ headers, body = {} } = {}) {
      const { account } = requireMaster(headers);
      const idName = requireLabel(body.idName ?? body.label);
      const keyId = account.subKeyIds.find((candidate) => {
        const existing = apiKeyStore.getKey(candidate);
        return existing && existing.label.toLowerCase() === idName.toLowerCase();
      });
      if (!keyId) throw new Error('key not found');
      apiKeyStore.deleteKey(keyId);
      account.subKeyIds = account.subKeyIds.filter((candidate) => candidate !== keyId);
      keyAccounts.delete(keyId);
      return { ok: true, deleted: idName };
    },

    revokeSubKey({ headers, params = {} } = {}) {
      const { account } = requireMaster(headers);
      if (params.keyId === account.keyId) {
        throw new Error('the master key cannot be revoked here');
      }
      if (!account.subKeyIds.includes(params.keyId)) {
        throw new Error('key not found');
      }
      const record = apiKeyStore.revokeKey(params.keyId);
      return { ok: true, key: { ...record, kind: 'sub', masterId: account.masterId } };
    },

    issueTesterKey({ body = {} } = {}) {
      const label = requireLabel(body.label);
      keyIssueLimiter.check(`tester-key:${label.toLowerCase()}`);
      const { rawKey, record } = apiKeyStore.issueKey({
        scopes: [...TESTER_SCOPES],
        sandbox: true,
        label,
      });
      return {
        apiKey: rawKey,
        key: record,
        limits: {
          network: TESTER_NETWORK,
          liveMoney: false,
          maxInputAmount,
        },
      };
    },

    async quote({ headers, body = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.QUOTE);
      if (body.inputAsset === 'NGN' || body.outputAsset === 'NGN') {
        throw new Error('tester sandbox does not support fiat payout');
      }
      if (typeof body.inputAmount === 'number' && body.inputAmount > maxInputAmount) {
        throw new Error(`tester sandbox inputAmount exceeds cap ${maxInputAmount}`);
      }
      const quote = await service.quote({
        ...body,
        userId: `tester:${verified.masterId}`,
      });
      quoteOwners.set(quote.quoteId, verified.masterId);
      return { ...quote, sandbox: true, network: TESTER_NETWORK };
    },

    async submit({ headers, body = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.SUBMIT);
      if (quoteOwners.get(body.quoteId) !== verified.masterId) {
        throw new Error('quote not found');
      }
      const record = await service.submit({
        quoteId: body.quoteId,
        idempotencyKey: `${verified.masterId}:${body.idempotencyKey ?? ''}`,
      });
      intentOwners.set(record.intentId, verified.masterId);
      return { ...record, sandbox: true, network: TESTER_NETWORK };
    },

    status({ headers, params = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.STATUS);
      const record = ownedIntent(verified.masterId, params.intentId);
      return { ...record, sandbox: true, network: TESTER_NETWORK };
    },

    refund({ headers, params = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.REFUND);
      ownedIntent(verified.masterId, params.intentId);
      const record = service.refund(params.intentId);
      return { ...record, sandbox: true, network: TESTER_NETWORK };
    },

    simulateFill({ headers, params = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.SUBMIT);
      const record = ownedIntent(verified.masterId, params.intentId);
      if (record.status !== 'open') {
        throw new Error(`only open intents can simulate a fill, current status ${record.status}`);
      }
      const filled = service.transition(record.intentId, 'filled', {
        txHash: `tester-fill-${record.intentId}`,
        simulated: true,
      });
      if (filled.intent.outputChain !== 'stellar') {
        return {
          ...filled,
          sandbox: true,
          network: TESTER_NETWORK,
          note: 'cross-chain tester intents stay filled until delivery proof verification',
        };
      }
      const settled = service.transition(record.intentId, 'settled', {
        txHash: `tester-settle-${record.intentId}`,
        simulated: true,
      });
      return { ...settled, sandbox: true, network: TESTER_NETWORK };
    },

    tokens() {
      return swapApi.tokens();
    },

    async swapQuote({ headers, body = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.QUOTE);
      return swapApi.quote({ ownerId: verified.masterId, body });
    },

    swapDepositSubmit({ headers, body = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.SUBMIT);
      return swapApi.depositSubmit({ ownerId: verified.masterId, body });
    },

    swapStatus({ headers, query = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.STATUS);
      return swapApi.status({ ownerId: verified.masterId, depositMemo: query.depositMemo });
    },

    swapGenerateIntent({ headers, body = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.QUOTE);
      return swapApi.generateIntent({ ownerId: verified.masterId, body });
    },

    swapSubmitIntent({ headers, body = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.SUBMIT);
      return swapApi.submitIntent({ ownerId: verified.masterId, body });
    },

    createOrder({ headers, body = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.SUBMIT);
      return swapApi.createOrder({ ownerId: verified.masterId, body });
    },

    listOrders({ headers } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.STATUS);
      return swapApi.listOrders({ ownerId: verified.masterId });
    },

    getOrder({ headers, params = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.STATUS);
      return swapApi.getOrder({ ownerId: verified.masterId, orderId: params.orderId });
    },

    fundOrder({ headers, params = {}, body = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.SUBMIT);
      return swapApi.fundOrder({ ownerId: verified.masterId, orderId: params.orderId, body });
    },

    simulateFillOrder({ headers, params = {}, body = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.SUBMIT);
      return swapApi.simulateFillOrder({ ownerId: verified.masterId, orderId: params.orderId, body });
    },

    cancelOrder({ headers, params = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.REFUND);
      return swapApi.cancelOrder({ ownerId: verified.masterId, orderId: params.orderId });
    },

    swapBalances({ headers } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.STATUS);
      return swapApi.ledgerBalances({ ownerId: verified.masterId });
    },

    reset({ headers } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.STATUS);
      let removedIntents = 0;
      let removedQuotes = 0;
      for (const [intentId, owner] of [...intentOwners.entries()]) {
        if (owner !== verified.masterId) continue;
        service.intents.delete(intentId);
        intentOwners.delete(intentId);
        removedIntents += 1;
      }
      for (const [key, intentId] of [...service.idempotency.entries()]) {
        if (!service.intents.has(intentId)) service.idempotency.delete(key);
      }
      for (const [quoteId, owner] of [...quoteOwners.entries()]) {
        if (owner !== verified.masterId) continue;
        service.quotes.delete(quoteId);
        quoteOwners.delete(quoteId);
        removedQuotes += 1;
      }
      return {
        ok: true,
        sandbox: true,
        network: TESTER_NETWORK,
        removedIntents,
        removedQuotes,
      };
    },
  };
}
