import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletService } from '../src/wallets.js';
import { ConversionService, SimulatedPayoutAdapter, withdrawalSplit } from '../src/conversion.js';

function setup() {
  let n = 0;
  const walletService = new WalletService({
    keypairFactory: () => {
      n += 1;
      return { publicKey: `GDRIVER${n}`, secretKey: `SDRIVER${n}` };
    },
  });
  const withdrawals = [];
  const contractClient = {
    async withdraw(request) {
      withdrawals.push(request);
      return { txHash: 'tx-withdraw', ...request };
    },
  };
  const rateProvider = {
    async rate({ fromAsset, toAsset }) {
      if (fromAsset === toAsset) return 1;
      if (toAsset === 'NGN') return 1500;
      if (fromAsset === 'XLM' && toAsset === 'USDC') return 0.1;
      throw new Error('no rate');
    },
  };
  const service = new ConversionService({
    walletService,
    contractClient,
    rateProvider,
    enairaAdapter: new SimulatedPayoutAdapter('enaira'),
    bankAdapter: new SimulatedPayoutAdapter('bank'),
  });
  return { walletService, service, withdrawals };
}

test('withdrawal split charges exactly ten percent', () => {
  assert.deepEqual(withdrawalSplit(25), { grossAmount: 25, feeAmount: 2.5, netAmount: 22.5 });
});

test('external Stellar payout withdraws net amount with driver as fee payer', async () => {
  const { walletService, service, withdrawals } = setup();
  walletService.provisionDefaultWallet({ userId: 'driver-1', role: 'driver' });
  walletService.setPayoutPreference('driver-1', {
    mode: 'external_stellar',
    externalAddress: 'GEXTERNALWALLET',
  });

  const result = await service.executeDriverPayout('driver-1', { grossAmount: 12 });

  assert.equal(result.status, 'withdrawn_to_external_wallet');
  assert.equal(result.split.feeAmount, 1.2);
  assert.equal(result.split.netAmount, 10.8);
  assert.equal(withdrawals[0].destination, 'GEXTERNALWALLET');
  assert.equal(withdrawals[0].feePayer, 'driver');
});

test('opt-in bank payout converts net USDC to NGN and records payout', async () => {
  const { walletService, service } = setup();
  walletService.provisionDefaultWallet({ userId: 'driver-1', role: 'driver' });
  walletService.setPayoutPreference('driver-1', {
    mode: 'bank',
    autoConvert: true,
    bankAccount: { bankCode: '058', accountNumber: '0123456789' },
  });

  const result = await service.executeDriverPayout('driver-1', { grossAmount: 10 });

  assert.equal(result.status, 'simulated_completed');
  assert.equal(result.conversion.convertedAmount, 13500);
  assert.equal(result.payout.amountNgn, 13500);
});

test('opt-in eNaira payout requires wallet id and records payout', async () => {
  const { walletService, service } = setup();
  walletService.provisionDefaultWallet({ userId: 'driver-1', role: 'driver' });
  walletService.setPayoutPreference('driver-1', {
    mode: 'enaira',
    autoConvert: true,
    enairaWalletId: 'enaira-driver-1',
  });

  const result = await service.executeDriverPayout('driver-1', { grossAmount: 10 });

  assert.equal(result.status, 'simulated_completed');
  assert.equal(result.payout.walletId, 'enaira-driver-1');
  assert.equal(result.payout.amountNgn, 13500);
});
