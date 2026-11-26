const DEFAULT_ASSET = Object.freeze({ code: 'USDC', issuer: null });

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
}

function parseAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('amount must be a positive number');
  }
  return value;
}

function assetKey(asset = DEFAULT_ASSET) {
  const code = asset.code ?? 'XLM';
  return asset.issuer ? `${code}:${asset.issuer}` : code;
}

export class InMemoryWalletStore {
  constructor() {
    this.walletsByUserId = new Map();
    this.creditedPayments = new Set();
    this.deposits = [];
  }

  getWallet(userId) {
    return this.walletsByUserId.get(userId) ?? null;
  }

  saveWallet(wallet) {
    this.walletsByUserId.set(wallet.userId, wallet);
    return wallet;
  }

  hasCreditedPayment(paymentId) {
    return this.creditedPayments.has(paymentId);
  }

  recordDeposit(deposit) {
    this.creditedPayments.add(deposit.paymentId);
    this.deposits.push(deposit);
    return deposit;
  }

  listDeposits(userId) {
    return this.deposits.filter((deposit) => deposit.userId === userId);
  }
}

export class WalletService {
  constructor({ store = new InMemoryWalletStore(), keypairFactory, omnibusAddress = null } = {}) {
    if (typeof keypairFactory !== 'function') {
      throw new Error('keypairFactory is required');
    }
    this.store = store;
    this.keypairFactory = keypairFactory;
    this.omnibusAddress = omnibusAddress;
  }

  provisionDefaultWallet({ userId, role }) {
    assertNonEmptyString(userId, 'userId');
    assertNonEmptyString(role, 'role');
    if (!['rider', 'driver'].includes(role)) {
      throw new Error('role must be rider or driver');
    }

    const existing = this.store.getWallet(userId);
    if (existing) {
      return { ...existing, created: false };
    }

    const keypair = this.keypairFactory();
    assertNonEmptyString(keypair.publicKey, 'keypair.publicKey');
    assertNonEmptyString(keypair.secretKey, 'keypair.secretKey');

    // Production storage must encrypt secretKey with the platform KMS before
    // persistence and must never log it. The in-memory store is for tests and
    // the testnet demo only.
    const wallet = {
      userId,
      role,
      publicKey: keypair.publicKey,
      secretKey: keypair.secretKey,
      depositMemo: `ORUVA:${userId}`,
      balances: {},
      activated: false,
      activationTxHash: null,
      payoutPreference: { mode: 'external_stellar', autoConvert: false },
      createdAt: new Date().toISOString(),
    };
    this.store.saveWallet(wallet);
    return { ...wallet, created: true };
  }

  getWallet(userId) {
    const wallet = this.store.getWallet(userId);
    if (!wallet) throw new Error(`wallet not found for user ${userId}`);
    return wallet;
  }

  async activateDefaultWallet(userId, activator) {
    const wallet = this.getWallet(userId);
    if (wallet.activated) return wallet;
    if (typeof activator !== 'function') throw new Error('activator is required');
    const result = await activator(wallet.publicKey);
    wallet.activated = true;
    wallet.activationTxHash = result?.txHash ?? result ?? null;
    this.store.saveWallet(wallet);
    return wallet;
  }

  depositInstructions(userId, asset = DEFAULT_ASSET) {
    const wallet = this.getWallet(userId);
    return {
      userId,
      address: wallet.publicKey,
      memo: wallet.depositMemo,
      asset,
      note: 'Send to this Stellar address. The memo is required only for the Oruva omnibus address.',
    };
  }

  creditExternalDeposit(payment) {
    const paymentId = payment.id ?? payment.paymentId ?? payment.txHash;
    assertNonEmptyString(paymentId, 'payment id');
    if (this.store.hasCreditedPayment(paymentId)) {
      return { credited: false, duplicate: true, paymentId };
    }

    const amount = parseAmount(payment.amount);
    const asset = payment.asset ?? { code: payment.assetCode ?? 'XLM', issuer: payment.assetIssuer ?? null };
    const wallet = this.#resolveDepositWallet(payment);
    const key = assetKey(asset);
    wallet.balances[key] = (wallet.balances[key] ?? 0) + amount;
    this.store.saveWallet(wallet);

    const deposit = {
      paymentId,
      txHash: payment.txHash ?? null,
      userId: wallet.userId,
      from: payment.from ?? null,
      to: payment.to,
      asset,
      amount,
      memo: payment.memo ?? null,
      creditedAt: new Date().toISOString(),
    };
    this.store.recordDeposit(deposit);
    return { credited: true, duplicate: false, deposit, balance: wallet.balances[key] };
  }

  async syncDepositsFromHorizon(userId, horizonClient) {
    const wallet = this.getWallet(userId);
    if (!horizonClient || typeof horizonClient.paymentsForAccount !== 'function') {
      throw new Error('horizonClient.paymentsForAccount is required');
    }
    const payments = await horizonClient.paymentsForAccount(wallet.publicKey);
    return payments.map((payment) => this.creditExternalDeposit(payment));
  }

  setPayoutPreference(userId, preference) {
    const wallet = this.getWallet(userId);
    const modes = ['external_stellar', 'usdc', 'enaira', 'bank'];
    if (!modes.includes(preference.mode)) {
      throw new Error(`mode must be one of ${modes.join(', ')}`);
    }
    wallet.payoutPreference = {
      mode: preference.mode,
      autoConvert: Boolean(preference.autoConvert),
      externalAddress: preference.externalAddress ?? null,
      enairaWalletId: preference.enairaWalletId ?? null,
      bankAccount: preference.bankAccount ?? null,
    };
    this.store.saveWallet(wallet);
    return wallet.payoutPreference;
  }

  #resolveDepositWallet(payment) {
    assertNonEmptyString(payment.to, 'payment.to');
    for (const wallet of this.store.walletsByUserId.values()) {
      if (wallet.publicKey === payment.to) return wallet;
    }
    if (this.omnibusAddress && payment.to === this.omnibusAddress) {
      const memo = payment.memo ?? '';
      const userId = memo.startsWith('ORUVA:') ? memo.slice('ORUVA:'.length) : null;
      if (userId) return this.getWallet(userId);
      throw new Error('omnibus deposit requires an ORUVA:<userId> memo');
    }
    throw new Error('deposit destination is not an Oruva wallet');
  }
}
