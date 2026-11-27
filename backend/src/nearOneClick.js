// NEAR Intents 1Click quote client interface.
//
// A route is shown only when 1Click returns a live quote for the exact
// asset and chain pair and amount. Transport is injected so tests run
// offline with recorded-shape fixtures. No API key is read here and no
// live call is made by the tests.

const XRPL_TRUSTLINE_STABLECOINS = new Set(['RLUSD', 'USDC']);

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

export function assertXrplAssetSupported(asset, chain) {
  if (chain !== 'xrpl') return;
  const symbol = requireText(asset, 'asset').toUpperCase();
  if (symbol === 'USDT') {
    throw new Error('USDT is not native on XRPL and must not be presented as an XRPL route asset');
  }
  if (symbol !== 'XRP' && !XRPL_TRUSTLINE_STABLECOINS.has(symbol)) {
    throw new Error(`unsupported XRPL asset ${symbol}`);
  }
}

function quoteFingerprint(request) {
  return [
    request.inputAsset,
    request.inputChain ?? 'stellar',
    request.outputAsset,
    request.outputChain,
    String(request.inputAmount),
    request.recipient,
  ].join('|');
}

function validateQuoteRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('quote request is required');
  const validated = {
    inputAsset: requireText(request.inputAsset, 'inputAsset'),
    inputChain: request.inputChain ?? 'stellar',
    inputAmount: parsePositiveAmount(request.inputAmount, 'inputAmount'),
    outputAsset: requireText(request.outputAsset, 'outputAsset'),
    outputChain: requireText(request.outputChain, 'outputChain'),
    recipient: requireText(request.recipient, 'recipient'),
  };
  assertXrplAssetSupported(validated.inputAsset, validated.inputChain);
  assertXrplAssetSupported(validated.outputAsset, validated.outputChain);
  return validated;
}

function isCompleteLiveQuote(live) {
  return Boolean(
    live
    && live.quoteId
    && live.depositAddress
    && Number(live.outputAmount) > 0
    && live.minimumOut != null
    && live.refundPath,
  );
}

export class NearOneClickClient {
  constructor({ transport = null } = {}) {
    this.transport = transport;
    this.quotes = new Map();
  }

  async quote(request) {
    let validated;
    try {
      validated = validateQuoteRequest(request);
    } catch {
      return null;
    }
    if (!this.transport || typeof this.transport.quote !== 'function') return null;
    const live = await this.transport.quote(validated);
    if (!isCompleteLiveQuote(live)) return null;
    const record = {
      quoteId: live.quoteId,
      depositAddress: live.depositAddress,
      outputAmount: parsePositiveAmount(live.outputAmount, 'liveQuote.outputAmount'),
      feeAmount: Number(live.feeAmount ?? 0),
      spreadBps: Number(live.spreadBps ?? 0),
      slippageBps: live.slippageBps == null ? null : Number(live.slippageBps),
      minimumOut: parsePositiveAmount(live.minimumOut, 'liveQuote.minimumOut'),
      refundPath: live.refundPath,
      sourceTx: live.sourceTx ?? null,
      solverDeliveryTx: live.solverDeliveryTx ?? null,
      request: validated,
      fingerprint: quoteFingerprint(validated),
      recordedAt: new Date().toISOString(),
    };
    this.quotes.set(record.quoteId, record);
    return record;
  }

  recordSourceTx(quoteId, sourceTx) {
    const record = this.getQuote(quoteId);
    record.sourceTx = requireText(sourceTx, 'sourceTx');
    return record;
  }

  recordSolverDeliveryTx(quoteId, solverDeliveryTx) {
    const record = this.getQuote(quoteId);
    record.solverDeliveryTx = requireText(solverDeliveryTx, 'solverDeliveryTx');
    return record;
  }

  getQuote(quoteId) {
    const record = this.quotes.get(requireText(quoteId, 'quoteId'));
    if (!record) throw new Error('1Click quote not found');
    return record;
  }
}
