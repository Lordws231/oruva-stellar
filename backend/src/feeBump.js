// Fee-bump sponsorship builder for Stellar transactions.
//
// The builder validates sponsorship terms offline and delegates
// envelope construction and signing to an injected signer, so this
// module holds no keys and makes no network calls. The inner
// transaction is an XDR string or a structured object carrying that
// XDR plus its fee, matching the plain-object style used by the
// other backend adapters.

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function parseFeeStroops(value, field) {
  let fee = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^[0-9]+$/.test(text)) {
      throw new Error(`${field} must be a positive integer number of stroops`);
    }
    fee = Number(text);
  }
  if (!Number.isSafeInteger(fee) || fee <= 0) {
    throw new Error(`${field} must be a positive integer number of stroops`);
  }
  return fee;
}

function normalizeInnerTx(innerTx) {
  if (typeof innerTx === 'string') {
    return { xdr: requireText(innerTx, 'innerTx'), fee: null, sourceAccount: null };
  }
  if (!innerTx || typeof innerTx !== 'object') {
    throw new Error('innerTx is required');
  }
  const xdr = innerTx.xdr ?? innerTx.envelopeXdr ?? innerTx.innerXdr ?? innerTx.transactionXdr;
  const rawFee = innerTx.fee ?? innerTx.innerFee ?? null;
  const rawSource = innerTx.sourceAccount ?? innerTx.source ?? null;
  return {
    xdr: requireText(xdr, 'innerTx.xdr'),
    fee: rawFee == null ? null : parseFeeStroops(rawFee, 'innerTx.fee'),
    sourceAccount: rawSource == null ? null : requireText(rawSource, 'innerTx.sourceAccount'),
  };
}

export function buildFeeBumpRequest({ innerTx, sponsor, fee, maxFee } = {}) {
  const sponsorAccount = requireText(sponsor, 'sponsor');
  const feeStroops = parseFeeStroops(fee, 'fee');
  const maxFeeStroops = parseFeeStroops(maxFee, 'maxFee');
  const inner = normalizeInnerTx(innerTx);
  if (feeStroops > maxFeeStroops) {
    throw new Error('fee exceeds maxFee cap');
  }
  if (inner.fee != null && feeStroops < inner.fee) {
    throw new Error('fee must be at least the inner transaction fee');
  }
  return {
    type: 'fee_bump',
    sponsor: sponsorAccount,
    fee: feeStroops,
    maxFee: maxFeeStroops,
    inner,
  };
}

function normalizeSignedEnvelope(result) {
  if (typeof result === 'string') {
    return { envelopeXdr: requireText(result, 'envelopeXdr'), signature: null };
  }
  if (result && typeof result === 'object') {
    const envelopeXdr = result.envelopeXdr ?? result.xdr ?? result.feeBumpXdr;
    return {
      envelopeXdr: requireText(envelopeXdr, 'envelopeXdr'),
      signature: result.signature ?? null,
    };
  }
  throw new Error('signer must return a fee-bump envelope XDR');
}

export class FeeBumpSponsor {
  constructor({ signer, transport = null } = {}) {
    if (!signer) throw new Error('signer is required');
    this.signer = signer;
    this.transport = transport;
  }

  async build({ innerTx, sponsor, fee, maxFee } = {}) {
    const request = buildFeeBumpRequest({ innerTx, sponsor, fee, maxFee });
    const signed = normalizeSignedEnvelope(await this.#callSigner(request));
    return { ...request, ...signed };
  }

  async submit(envelope) {
    if (!this.transport) {
      throw new Error('transport is required to submit a fee-bump envelope');
    }
    if (!envelope || typeof envelope !== 'object') {
      throw new Error('fee-bump envelope is required');
    }
    requireText(envelope.envelopeXdr, 'envelopeXdr');
    if (typeof this.transport.submitFeeBump === 'function') {
      return this.transport.submitFeeBump(envelope);
    }
    if (typeof this.transport.submit === 'function') {
      return this.transport.submit(envelope);
    }
    throw new Error('transport must provide submitFeeBump or submit');
  }

  async #callSigner(request) {
    if (typeof this.signer === 'function') return this.signer(request);
    if (typeof this.signer.signFeeBump === 'function') return this.signer.signFeeBump(request);
    if (typeof this.signer.sign === 'function') return this.signer.sign(request);
    throw new Error('signer must be a function or provide signFeeBump or sign');
  }
}

export async function createFeeBumpEnvelope({ signer, innerTx, sponsor, fee, maxFee } = {}) {
  return new FeeBumpSponsor({ signer }).build({ innerTx, sponsor, fee, maxFee });
}
