// Oruva Intents verifier ledger (testnet model).
//
// Mirrors the verifier-ledger pattern: deposited assets are credited
// to accounts in one ledger, signed intents move value between
// ledger accounts, and withdrawals debit the ledger. Amounts are
// integer strings in the smallest unit of each asset. Settlement of
// token_diff intents is atomic: every party's diff must net to zero
// per asset and no balance may go negative, or nothing applies.
// Nonces are single-use per signer to block replay.

export const VERIFYING_CONTRACT = 'oruva-intents-verifier';

function toAmount(value, { signed = false } = {}) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error('amount must be an integer string in the smallest unit');
  }
  const amount = BigInt(value);
  if (!signed && amount < 0n) throw new Error('amount must not be negative');
  return amount;
}

function requireSigner(signerId) {
  if (typeof signerId !== 'string' || signerId.trim() === '') {
    throw new Error('signer_id is required');
  }
  return signerId.trim();
}

function requireNonce(nonce) {
  if (typeof nonce !== 'string' || nonce.trim() === '') {
    throw new Error('nonce is required');
  }
  const bytes = Buffer.from(nonce.trim(), 'base64');
  if (bytes.length !== 32) throw new Error('nonce must be a 256-bit base64 value');
  return nonce.trim();
}

export class VerifierLedger {
  constructor({ verifyingContract = VERIFYING_CONTRACT, now = () => new Date() } = {}) {
    this.verifyingContract = verifyingContract;
    this.now = now;
    this.balances = new Map();
    this.nonces = new Map();
    this.publicKeys = new Map();
  }

  account(signerId) {
    const signer = requireSigner(signerId);
    if (!this.balances.has(signer)) this.balances.set(signer, new Map());
    return this.balances.get(signer);
  }

  balanceOf(signerId, assetId) {
    return (this.account(signerId).get(assetId) ?? 0n).toString();
  }

  balancesOf(signerId) {
    const out = {};
    for (const [asset, amount] of this.account(signerId)) out[asset] = amount.toString();
    return out;
  }

  deposit(signerId, assetId, amount) {
    const value = toAmount(amount);
    if (value === 0n) throw new Error('deposit amount must be positive');
    const account = this.account(signerId);
    account.set(assetId, (account.get(assetId) ?? 0n) + value);
    return { signerId, assetId, balance: account.get(assetId).toString() };
  }

  withdraw(signerId, assetId, amount) {
    const value = toAmount(amount);
    if (value === 0n) throw new Error('withdraw amount must be positive');
    const account = this.account(signerId);
    const balance = account.get(assetId) ?? 0n;
    if (balance < value) throw new Error('insufficient ledger balance');
    account.set(assetId, balance - value);
    return { signerId, assetId, balance: account.get(assetId).toString() };
  }

  registerKey(signerId, publicKey) {
    const signer = requireSigner(signerId);
    if (typeof publicKey !== 'string' || publicKey.trim() === '') {
      throw new Error('public key is required');
    }
    if (!this.publicKeys.has(signer)) this.publicKeys.set(signer, new Set());
    this.publicKeys.get(signer).add(publicKey.trim());
    return { signerId: signer, keys: [...this.publicKeys.get(signer)] };
  }

  hasKey(signerId, publicKey) {
    return this.publicKeys.get(signerId)?.has(publicKey) ?? false;
  }

  applyDiffs(diffEntries) {
    const net = new Map();
    const planned = new Map();
    for (const entry of diffEntries) {
      const signer = requireSigner(entry.signer_id);
      const account = this.account(signer);
      if (!planned.has(signer)) planned.set(signer, new Map(account));
      const target = planned.get(signer);
      for (const [asset, raw] of Object.entries(entry.diff ?? {})) {
        const delta = toAmount(raw, { signed: true });
        net.set(asset, (net.get(asset) ?? 0n) + delta);
        target.set(asset, (target.get(asset) ?? 0n) + delta);
      }
    }
    for (const [asset, total] of net) {
      if (total !== 0n) throw new Error(`token_diff does not net to zero for ${asset}`);
    }
    for (const [signer, target] of planned) {
      for (const [asset, amount] of target) {
        if (amount < 0n) throw new Error(`insufficient ledger balance for ${signer} in ${asset}`);
      }
    }
    for (const [signer, target] of planned) this.balances.set(signer, target);
  }

  executeIntents(payload = {}) {
    const signer = requireSigner(payload.signer_id);
    if (payload.verifying_contract !== this.verifyingContract) {
      throw new Error('verifying_contract mismatch');
    }
    const deadline = new Date(payload.deadline);
    if (Number.isNaN(deadline.getTime()) || deadline <= this.now()) {
      throw new Error('intent deadline has passed');
    }
    const nonce = requireNonce(payload.nonce);
    if (!this.nonces.has(signer)) this.nonces.set(signer, new Set());
    if (this.nonces.get(signer).has(nonce)) throw new Error('nonce already used');
    const intents = Array.isArray(payload.intents) ? payload.intents : [];
    if (intents.length === 0) throw new Error('intents must not be empty');

    for (const intent of intents) {
      if (intent.type === 'token_diff') {
        const entries = Array.isArray(intent.diffs)
          ? intent.diffs
          : [
              { signer_id: signer, diff: intent.diff },
              { signer_id: intent.counterparty_id, diff: intent.counterparty_diff },
            ];
        this.applyDiffs(entries);
      } else if (intent.type === 'transfer') {
        const amount = toAmount(intent.amount);
        this.withdraw(signer, intent.asset, amount.toString());
        this.deposit(intent.recipient, intent.asset, amount.toString());
      } else if (intent.type === 'add_public_key') {
        this.registerKey(signer, intent.public_key);
      } else if (intent.type === 'remove_public_key') {
        this.publicKeys.get(signer)?.delete(intent.public_key);
      } else {
        throw new Error(`unsupported intent type: ${intent.type}`);
      }
    }

    this.nonces.get(signer).add(nonce);
    return { executed: intents.length, balances: this.balancesOf(signer) };
  }
}

export function createVerifierLedger(options = {}) {
  return new VerifierLedger(options);
}
