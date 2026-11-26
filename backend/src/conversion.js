function parseAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('amount must be a positive number');
  }
  return value;
}

export function withdrawalSplit(grossAmount) {
  const gross = parseAmount(grossAmount);
  const fee = Math.floor(gross * 10) / 100;
  return { grossAmount: gross, feeAmount: fee, netAmount: gross - fee };
}

export class SimulatedPayoutAdapter {
  constructor(name) {
    this.name = name;
    this.payouts = [];
  }

  async payout(request) {
    const payout = {
      id: `${this.name}-${this.payouts.length + 1}`,
      status: 'simulated_completed',
      ...request,
      createdAt: new Date().toISOString(),
    };
    this.payouts.push(payout);
    return payout;
  }
}

export class PartnerRequiredPayoutAdapter {
  constructor(name) {
    this.name = name;
  }

  async payout() {
    return {
      status: 'partner_required',
      adapter: this.name,
      reason: 'Live payout requires partner credentials and funded settlement accounts.',
    };
  }
}

export class ConversionService {
  constructor({ walletService, contractClient, rateProvider, enairaAdapter, bankAdapter }) {
    this.walletService = walletService;
    this.contractClient = contractClient;
    this.rateProvider = rateProvider;
    this.enairaAdapter = enairaAdapter;
    this.bankAdapter = bankAdapter;
  }

  async quote({ fromAsset, toAsset, amount }) {
    const value = parseAmount(amount);
    if (!this.rateProvider || typeof this.rateProvider.rate !== 'function') {
      throw new Error('rateProvider.rate is required');
    }
    const rate = await this.rateProvider.rate({ fromAsset, toAsset });
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('invalid conversion rate');
    return { fromAsset, toAsset, amount: value, rate, convertedAmount: value * rate };
  }

  async executeDriverPayout(driverId, { grossAmount, sourceAsset = 'USDC' } = {}) {
    const wallet = this.walletService.getWallet(driverId);
    if (wallet.role !== 'driver') throw new Error('payout user must be a driver');
    const preference = wallet.payoutPreference;
    const split = withdrawalSplit(grossAmount);

    const destination = this.#destinationFor(wallet, preference);
    const withdrawal = await this.contractClient.withdraw({
      driver: wallet.publicKey,
      driverSecretKey: wallet.secretKey,
      destination,
      grossAmount: split.grossAmount,
      feeAmount: split.feeAmount,
      netAmount: split.netAmount,
      feePayer: 'driver',
    });

    if (preference.mode === 'external_stellar') {
      return { status: 'withdrawn_to_external_wallet', split, withdrawal };
    }

    if (preference.mode === 'usdc') {
      const conversion = sourceAsset === 'USDC'
        ? { fromAsset: 'USDC', toAsset: 'USDC', amount: split.netAmount, rate: 1, convertedAmount: split.netAmount }
        : await this.quote({ fromAsset: sourceAsset, toAsset: 'USDC', amount: split.netAmount });
      return { status: 'converted_to_usdc', split, withdrawal, conversion };
    }

    const conversion = await this.quote({
      fromAsset: sourceAsset,
      toAsset: 'NGN',
      amount: split.netAmount,
    });

    if (preference.mode === 'enaira') {
      if (!preference.enairaWalletId) throw new Error('enairaWalletId is required for eNaira payout');
      const payout = await this.enairaAdapter.payout({
        driverId,
        walletId: preference.enairaWalletId,
        amountNgn: conversion.convertedAmount,
        source: 'stellar_usdc_conversion',
      });
      return { status: payout.status, split, withdrawal, conversion, payout };
    }

    if (preference.mode === 'bank') {
      if (!preference.bankAccount) throw new Error('bankAccount is required for bank payout');
      const payout = await this.bankAdapter.payout({
        driverId,
        bankAccount: preference.bankAccount,
        amountNgn: conversion.convertedAmount,
        source: 'stellar_usdc_conversion',
      });
      return { status: payout.status, split, withdrawal, conversion, payout };
    }

    throw new Error(`unsupported payout mode ${preference.mode}`);
  }

  #destinationFor(wallet, preference) {
    if (preference.mode === 'external_stellar') {
      if (!preference.externalAddress) throw new Error('externalAddress is required for external Stellar withdrawal');
      return preference.externalAddress;
    }
    // Conversion and fiat payout modes withdraw to the driver's Oruva
    // Stellar wallet first; the backend then converts and pays out.
    return wallet.publicKey;
  }
}
