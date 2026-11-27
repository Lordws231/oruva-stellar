// CCTP bridge adapter for Stellar USDC to Polygon USDC.
//
// Production destination is Polygon (domain 7) per
// docs/platform-wiring-spec.md. The Base Sepolia testnet proof stands
// as mechanism proof only. This adapter owns quote, burn, attestation
// and mint state for one payout ID. Transport is injected so tests run
// offline with simulated responses. No live burn is submitted here.

export const CCTP_STELLAR_DOMAIN = 27;
export const CCTP_POLYGON_DOMAIN = 7;
export const CCTP_FINALITY_THRESHOLD = 2000;

const ALLOWED_TRANSITIONS = {
  quoted: new Set(['burned', 'failed_reconcile']),
  burned: new Set(['attesting', 'minted', 'failed_reconcile']),
  attesting: new Set(['minted', 'failed_reconcile']),
  minted: new Set(['completed', 'failed_reconcile']),
  completed: new Set(),
  failed_reconcile: new Set(),
};

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value;
}

function parseAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amountUsdc must be a positive number');
  }
  const sixDecimal = Math.round(amount * 1_000_000) / 1_000_000;
  if (sixDecimal !== amount) {
    throw new Error('amountUsdc must use 6-decimal precision');
  }
  return amount;
}

export function cctpFeeQuotePath({
  sourceDomain = CCTP_STELLAR_DOMAIN,
  destinationDomain = CCTP_POLYGON_DOMAIN,
  forward = true,
} = {}) {
  return `/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}?forward=${forward ? 'true' : 'false'}`;
}

export function cctpAttestationPath({ sourceDomain = CCTP_STELLAR_DOMAIN, burnHash } = {}) {
  return `/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(requireText(burnHash, 'burnHash'))}`;
}

function selectFeeEntry(feeQuote) {
  const entries = Array.isArray(feeQuote) ? feeQuote : feeQuote?.fees;
  if (!Array.isArray(entries)) throw new Error('fee quote response must include fee entries');
  const entry = entries.find((item) => Number(item.finalityThreshold) === CCTP_FINALITY_THRESHOLD);
  if (!entry) throw new Error('fee quote is missing finalityThreshold 2000');
  return entry;
}

function maxFeeSevenDecimals(amountUsdc, entry) {
  const protocolFee6 = Math.ceil((amountUsdc * 1_000_000 * Number(entry.minimumFee ?? 0)) / 10000);
  const forwardFee6 = Number(entry.forwardFee ?? 0);
  if (!Number.isFinite(forwardFee6) || forwardFee6 < 0) {
    throw new Error('fee quote forwardFee is invalid');
  }
  return (protocolFee6 + forwardFee6) * 10;
}

export class CctpBridgeAdapter {
  constructor({ transport, now = () => new Date() } = {}) {
    if (!transport) throw new Error('transport is required');
    this.transport = transport;
    this.now = now;
    this.payouts = new Map();
  }

  async quote({ payoutId, rideId, amountUsdc, mintRecipient, conversionReference = null }) {
    requireText(payoutId, 'payoutId');
    requireText(rideId, 'rideId');
    requireText(mintRecipient, 'mintRecipient');
    const amount = parseAmount(amountUsdc);
    const existing = this.payouts.get(payoutId);
    if (existing) {
      if (
        existing.rideId !== rideId
        || existing.amountUsdc !== amount
        || existing.mintRecipient !== mintRecipient
      ) {
        throw new Error('payoutId already exists with different bridge terms');
      }
      return existing;
    }
    const path = cctpFeeQuotePath();
    const feeQuote = await this.transport.getFeeQuote(path);
    const entry = selectFeeEntry(feeQuote);
    const record = {
      payoutId,
      rideId,
      status: 'quoted',
      sourceDomain: CCTP_STELLAR_DOMAIN,
      destinationDomain: CCTP_POLYGON_DOMAIN,
      amountUsdc: amount,
      mintRecipient,
      conversionReference,
      finalCreditReference: null,
      burnHash: null,
      mintHash: null,
      attestationStatus: null,
      forwardState: null,
      quote: {
        endpoint: path,
        finalityThreshold: CCTP_FINALITY_THRESHOLD,
        minimumFeeBps: Number(entry.minimumFee ?? 0),
        forwardFee6: Number(entry.forwardFee ?? 0),
        maxFee7: maxFeeSevenDecimals(amount, entry),
        quotedAt: this.now().toISOString(),
      },
      events: [{ type: 'cctp_quoted', at: this.now().toISOString() }],
    };
    this.payouts.set(payoutId, record);
    return record;
  }

  async submitBurn(payoutId) {
    const record = this.status(payoutId);
    if (record.burnHash || record.status !== 'quoted') {
      throw new Error('burn already submitted for payoutId; check status before any resubmission');
    }
    const result = await this.transport.submitBurn({
      payoutId: record.payoutId,
      rideId: record.rideId,
      amountUsdc: record.amountUsdc,
      sourceDomain: record.sourceDomain,
      destinationDomain: record.destinationDomain,
      mintRecipient: record.mintRecipient,
      maxFee7: record.quote.maxFee7,
      minFinalityThreshold: CCTP_FINALITY_THRESHOLD,
    });
    record.burnHash = requireText(result?.burnHash, 'burnHash');
    this.#transition(record, 'burned', { burnHash: record.burnHash });
    return record;
  }

  async pollAttestation(payoutId) {
    const record = this.status(payoutId);
    if (record.status === 'minted' || record.status === 'completed') return record;
    if (!record.burnHash) throw new Error('burn must be submitted before attestation polling');
    const result = await this.transport.getAttestation(cctpAttestationPath({ burnHash: record.burnHash }));
    record.attestationStatus = result?.status ?? null;
    record.forwardState = result?.forwardState ?? null;
    if (result?.status === 'complete' && result?.forwardState === 'CONFIRMED' && result?.forwardTxHash) {
      record.mintHash = result.forwardTxHash;
      this.#transition(record, 'minted', { mintHash: record.mintHash });
      return record;
    }
    if (record.status === 'burned') {
      this.#transition(record, 'attesting', { attestationStatus: record.attestationStatus });
    } else {
      record.events.push({ type: 'cctp_attestation_polled', at: this.now().toISOString(), attestationStatus: record.attestationStatus });
    }
    return record;
  }

  recordFinalCredit(payoutId, { conversionReference = null, finalCreditReference } = {}) {
    const record = this.status(payoutId);
    if (record.status !== 'minted') {
      throw new Error('final credit can only be recorded after mint completion');
    }
    if (conversionReference != null) record.conversionReference = conversionReference;
    record.finalCreditReference = requireText(finalCreditReference, 'finalCreditReference');
    this.#transition(record, 'completed', { finalCreditReference: record.finalCreditReference });
    return record;
  }

  status(payoutId) {
    const record = this.payouts.get(requireText(payoutId, 'payoutId'));
    if (!record) throw new Error('payout not found');
    return record;
  }

  reconciliationRecord(payoutId) {
    const record = this.status(payoutId);
    return {
      payoutId: record.payoutId,
      rideId: record.rideId,
      status: record.status,
      sourceDomain: record.sourceDomain,
      destinationDomain: record.destinationDomain,
      amountUsdc: record.amountUsdc,
      burnHash: record.burnHash,
      mintHash: record.mintHash,
      conversionReference: record.conversionReference,
      finalCreditReference: record.finalCreditReference,
      quote: { ...record.quote },
      events: [...record.events],
    };
  }

  #transition(record, nextStatus, evidence = {}) {
    if (!ALLOWED_TRANSITIONS[record.status]?.has(nextStatus)) {
      throw new Error(`cannot move CCTP payout from ${record.status} to ${nextStatus}`);
    }
    record.status = nextStatus;
    record.events.push({ type: `cctp_${nextStatus}`, at: this.now().toISOString(), ...evidence });
  }
}
