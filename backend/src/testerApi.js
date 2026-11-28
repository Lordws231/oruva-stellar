// Oruva Intents Tester API and sandbox.
//
// A testnet-only surface that lets other developers use and test
// Oruva Intents without touching live money. Developers issue
// their own sandbox keys, run capped quote, submit, status, refund
// and simulated-fill flows, and reset their sandbox state. Every
// record is isolated per API key. Settlement here is simulated:
// no real funds move and no mainnet path exists in this module.

import { API_KEY_SCOPES, ApiKeyStore } from './apiKeys.js';
import {
  ApiKeyRateLimiter,
  CctpRouteAdapter,
  IntentService,
  StellarDexRouteAdapter,
} from './intents.js';

export const TESTER_NETWORK = 'stellar-testnet';
export const TESTER_DEFAULT_MAX_INPUT_AMOUNT = 10;

export const TESTER_API_ROUTES = Object.freeze([
  'GET /tester/v1/health',
  'POST /tester/v1/keys',
  'POST /tester/v1/intents/quote',
  'POST /tester/v1/intents/submit',
  'GET /tester/v1/intents/:intentId',
  'POST /tester/v1/intents/:intentId/refund',
  'POST /tester/v1/intents/:intentId/simulate-fill',
  'POST /tester/v1/reset',
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
  const quoteOwners = new Map();
  const intentOwners = new Map();

  function authorize(headers, scope) {
    const verified = apiKeyStore.assertKey(apiKeyFrom(headers), scope, {
      requireSandbox: true,
    });
    rateLimiter.check(verified.keyId);
    return verified;
  }

  function ownedIntent(keyId, intentId) {
    if (intentOwners.get(intentId) !== keyId) {
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
        maxInputAmount,
        routes: [...TESTER_API_ROUTES],
      };
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
        userId: `tester:${verified.keyId}`,
      });
      quoteOwners.set(quote.quoteId, verified.keyId);
      return { ...quote, sandbox: true, network: TESTER_NETWORK };
    },

    async submit({ headers, body = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.SUBMIT);
      if (quoteOwners.get(body.quoteId) !== verified.keyId) {
        throw new Error('quote not found');
      }
      const record = await service.submit({
        quoteId: body.quoteId,
        idempotencyKey: `${verified.keyId}:${body.idempotencyKey ?? ''}`,
      });
      intentOwners.set(record.intentId, verified.keyId);
      return { ...record, sandbox: true, network: TESTER_NETWORK };
    },

    status({ headers, params = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.STATUS);
      const record = ownedIntent(verified.keyId, params.intentId);
      return { ...record, sandbox: true, network: TESTER_NETWORK };
    },

    refund({ headers, params = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.REFUND);
      ownedIntent(verified.keyId, params.intentId);
      const record = service.refund(params.intentId);
      return { ...record, sandbox: true, network: TESTER_NETWORK };
    },

    simulateFill({ headers, params = {} } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.SUBMIT);
      const record = ownedIntent(verified.keyId, params.intentId);
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

    reset({ headers } = {}) {
      const verified = authorize(headers, API_KEY_SCOPES.STATUS);
      let removedIntents = 0;
      let removedQuotes = 0;
      for (const [intentId, owner] of [...intentOwners.entries()]) {
        if (owner !== verified.keyId) continue;
        service.intents.delete(intentId);
        intentOwners.delete(intentId);
        removedIntents += 1;
      }
      for (const [key, intentId] of [...service.idempotency.entries()]) {
        if (!service.intents.has(intentId)) service.idempotency.delete(key);
      }
      for (const [quoteId, owner] of [...quoteOwners.entries()]) {
        if (owner !== verified.keyId) continue;
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
