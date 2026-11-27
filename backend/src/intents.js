// Oruva Stellar Intents backend skeleton (testnet MVP).
//
// Public developer platform surface: quote, submit, status and refund
// flows with idempotency keys, solver bids, route adapters and evidence
// packs. Route adapters here are simulated or quote-gated; no live fiat
// payout is claimed until partner and licensing gates clear.

export const INTENT_KINDS = new Set([
  'fare_payment',
  'driver_payout',
  'automatic_convert',
  'manual_convert',
  'swap_convert',
  'cross_chain_payout',
  'escrow_release',
  'recurring_session',
  'agent_payment',
  'bulk_disbursement',
  'anchor_off_ramp',
  'anchor_on_ramp',
]);

const TERMINAL_STATUSES = new Set(['settled', 'refunded', 'cancelled', 'failed']);

const ALLOWED_TRANSITIONS = {
  quoted: new Set(['open', 'cancelled', 'failed']),
  open: new Set(['filled', 'refunded', 'cancelled', 'failed']),
  filled: new Set(['settled', 'failed']),
  settled: new Set(),
  refunded: new Set(),
  cancelled: new Set(),
  failed: new Set(),
};

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value;
}

function parsePositiveAmount(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return amount;
}

function validateIntentRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('intent request is required');
  const kind = requireText(request.kind, 'kind');
  if (!INTENT_KINDS.has(kind)) throw new Error(`unsupported intent kind ${kind}`);
  const inputAmount = parsePositiveAmount(request.inputAmount, 'inputAmount');
  const minOutputAmount = parsePositiveAmount(request.minOutputAmount, 'minOutputAmount');
  const deadline = new Date(requireText(request.deadline, 'deadline'));
  if (Number.isNaN(deadline.getTime())) throw new Error('deadline must be an ISO date');
  return {
    kind,
    userId: requireText(request.userId, 'userId'),
    inputAsset: requireText(request.inputAsset, 'inputAsset'),
    inputAmount,
    outputAsset: requireText(request.outputAsset, 'outputAsset'),
    outputChain: requireText(request.outputChain, 'outputChain'),
    minOutputAmount,
    recipient: requireText(request.recipient, 'recipient'),
    deadline: deadline.toISOString(),
    spendLimit: request.spendLimit == null ? null : parsePositiveAmount(request.spendLimit, 'spendLimit'),
  };
}

export class StellarDexRouteAdapter {
  constructor({ rate = 1, feeBps = 10 } = {}) {
    this.name = 'stellar_dex_path_payment';
    this.rate = rate;
    this.feeBps = feeBps;
  }

  async quote(request) {
    if (request.outputChain !== 'stellar') return null;
    const gross = request.inputAmount * this.rate;
    const feeAmount = gross * (this.feeBps / 10000);
    return {
      route: this.name,
      solver: 'oruva',
      outputAmount: gross - feeAmount,
      feeAmount,
      spreadBps: this.feeBps,
      evidence: { type: 'simulated_stellar_path_quote' },
    };
  }
}

export class CctpRouteAdapter {
  constructor({ rate = 0.99, feeBps = 20 } = {}) {
    this.name = 'cctp_stellar_to_polygon';
    this.rate = rate;
    this.feeBps = feeBps;
  }

  async quote(request) {
    if (request.inputAsset !== 'USDC' || request.outputChain !== 'polygon') return null;
    const gross = request.inputAmount * this.rate;
    const feeAmount = gross * (this.feeBps / 10000);
    return {
      route: this.name,
      solver: 'oruva',
      outputAmount: gross - feeAmount,
      feeAmount,
      spreadBps: this.feeBps,
      evidence: { type: 'cctp_quote_required_before_live_burn' },
    };
  }
}

export class NearOneClickRouteAdapter {
  constructor({ liveQuoteProvider = null } = {}) {
    this.name = 'near_intents_1click';
    this.liveQuoteProvider = liveQuoteProvider;
  }

  async quote(request) {
    // Guardrail: no live 1Click quote for the exact pair and amount,
    // no route is shown.
    if (!this.liveQuoteProvider) return null;
    const live = await this.liveQuoteProvider.quote(request);
    if (!live || !live.quoteId || !live.depositAddress) return null;
    return {
      route: this.name,
      solver: 'near_1click_solver_network',
      outputAmount: parsePositiveAmount(live.outputAmount, 'liveQuote.outputAmount'),
      feeAmount: Number(live.feeAmount ?? 0),
      spreadBps: Number(live.spreadBps ?? 0),
      evidence: {
        type: 'near_1click_live_quote',
        quoteId: live.quoteId,
        depositAddress: live.depositAddress,
        minimumOut: live.minimumOut ?? null,
        refundPath: live.refundPath ?? null,
      },
    };
  }
}

export class FlutterwaveAnchorRouteAdapter {
  constructor() {
    this.name = 'flutterwave_anchor_ngn';
  }

  async quote() {
    // Fiat payout stays unavailable in quotes until stablecoin
    // approval, wallet confirmation, compliance review, Paystack DVA
    // receiving confirmation and a small-value live test are complete.
    return null;
  }
}

export function selectBestBid(bids, minOutputAmount) {
  const eligible = bids
    .filter((bid) => bid && Number(bid.outputAmount) >= minOutputAmount)
    .sort((a, b) => {
      if (b.outputAmount !== a.outputAmount) return b.outputAmount - a.outputAmount;
      return String(a.solver).localeCompare(String(b.solver));
    });
  return eligible[0] ?? null;
}

export class IntentService {
  constructor({ routeAdapters = [] } = {}) {
    this.routeAdapters = routeAdapters;
    this.quotes = new Map();
    this.intents = new Map();
    this.idempotency = new Map();
    this.sequence = 0;
  }

  async quote(request) {
    const intent = validateIntentRequest(request);
    if (intent.spendLimit != null && intent.inputAmount > intent.spendLimit) {
      throw new Error('inputAmount exceeds spendLimit');
    }
    const bids = [];
    for (const adapter of this.routeAdapters) {
      const bid = await adapter.quote(intent);
      if (bid) bids.push(bid);
    }
    const bestBid = selectBestBid(bids, intent.minOutputAmount);
    const quoteId = `quote-${++this.sequence}`;
    const quote = {
      quoteId,
      status: bestBid ? 'quoted' : 'no_route',
      intent,
      bids,
      bestBid,
      createdAt: new Date().toISOString(),
    };
    this.quotes.set(quoteId, quote);
    return quote;
  }

  async submit({ quoteId, idempotencyKey }) {
    requireText(idempotencyKey, 'idempotencyKey');
    if (this.idempotency.has(idempotencyKey)) {
      return this.intents.get(this.idempotency.get(idempotencyKey));
    }
    const quote = this.quotes.get(requireText(quoteId, 'quoteId'));
    if (!quote) throw new Error('quote not found');
    if (!quote.bestBid) throw new Error('quote has no eligible route');
    const intentId = `intent-${++this.sequence}`;
    const record = {
      intentId,
      quoteId,
      idempotencyKey,
      status: 'open',
      intent: quote.intent,
      selectedBid: quote.bestBid,
      txHashes: [],
      events: [{ type: 'intent_opened', at: new Date().toISOString() }],
      balances: { inputLocked: quote.intent.inputAmount, outputDelivered: 0 },
    };
    this.intents.set(intentId, record);
    this.idempotency.set(idempotencyKey, intentId);
    return record;
  }

  status(intentId) {
    const record = this.intents.get(requireText(intentId, 'intentId'));
    if (!record) throw new Error('intent not found');
    return record;
  }

  transition(intentId, nextStatus, evidence = {}) {
    const record = this.status(intentId);
    if (TERMINAL_STATUSES.has(record.status)) {
      throw new Error(`intent is already ${record.status}`);
    }
    if (!ALLOWED_TRANSITIONS[record.status]?.has(nextStatus)) {
      throw new Error(`cannot move intent from ${record.status} to ${nextStatus}`);
    }
    record.status = nextStatus;
    if (evidence.txHash) record.txHashes.push(evidence.txHash);
    if (nextStatus === 'settled') {
      record.balances.outputDelivered = record.selectedBid.outputAmount;
      record.balances.inputLocked = 0;
    }
    record.events.push({ type: `intent_${nextStatus}`, at: new Date().toISOString(), ...evidence });
    return record;
  }

  refund(intentId, now = new Date()) {
    const record = this.status(intentId);
    if (record.status !== 'open') throw new Error('only open intents can refund');
    if (now <= new Date(record.intent.deadline)) {
      throw new Error('deadline has not passed');
    }
    record.balances.inputLocked = 0;
    return this.transition(intentId, 'refunded', { refundPath: 'locked_input_returned_to_user' });
  }

  evidencePack(intentId) {
    const record = this.status(intentId);
    return {
      intentId: record.intentId,
      status: record.status,
      kind: record.intent.kind,
      selectedRoute: record.selectedBid.route,
      solver: record.selectedBid.solver,
      txHashes: [...record.txHashes],
      events: [...record.events],
      balances: { ...record.balances },
      quoteEvidence: record.selectedBid.evidence,
    };
  }
}

export class ApiKeyRateLimiter {
  constructor({ limit = 60, windowMs = 60000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  check(apiKey, now = Date.now()) {
    requireText(apiKey, 'apiKey');
    const bucket = (this.buckets.get(apiKey) ?? []).filter((at) => now - at < this.windowMs);
    if (bucket.length >= this.limit) throw new Error('rate limit exceeded');
    bucket.push(now);
    this.buckets.set(apiKey, bucket);
    return { remaining: this.limit - bucket.length };
  }
}

export function createIntentApiHandlers({ service, rateLimiter = new ApiKeyRateLimiter() }) {
  function guard(headers = {}) {
    const apiKey = headers['x-api-key'] ?? headers['X-Api-Key'];
    rateLimiter.check(apiKey);
  }
  return {
    async quote({ headers, body }) {
      guard(headers);
      return service.quote(body);
    },
    async submit({ headers, body }) {
      guard(headers);
      return service.submit(body);
    },
    async status({ headers, params }) {
      guard(headers);
      return service.status(params.intentId);
    },
    async refund({ headers, params }) {
      guard(headers);
      return service.refund(params.intentId);
    },
  };
}

export function webhookEvent(record, type) {
  return {
    type,
    intentId: record.intentId,
    status: record.status,
    kind: record.intent.kind,
    createdAt: new Date().toISOString(),
  };
}
