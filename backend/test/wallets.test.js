import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletService } from '../src/wallets.js';

function fakeFactory() {
  let n = 0;
  return () => {
    n += 1;
    return { publicKey: `GTEST${n}`, secretKey: `STEST${n}` };
  };
}

test('provisions default wallets for riders and drivers idempotently', () => {
  const service = new WalletService({ keypairFactory: fakeFactory() });
  const rider = service.provisionDefaultWallet({ userId: 'rider-1', role: 'rider' });
  const driver = service.provisionDefaultWallet({ userId: 'driver-1', role: 'driver' });
  const again = service.provisionDefaultWallet({ userId: 'driver-1', role: 'driver' });

  assert.equal(rider.created, true);
  assert.equal(driver.created, true);
  assert.equal(again.created, false);
  assert.equal(again.publicKey, driver.publicKey);
  assert.equal(service.depositInstructions('rider-1').address, rider.publicKey);
  assert.equal(service.depositInstructions('driver-1').memo, 'ORUVA:driver-1');
});

test('activates a default wallet before external deposits', async () => {
  const service = new WalletService({ keypairFactory: fakeFactory() });
  const wallet = service.provisionDefaultWallet({ userId: 'driver-1', role: 'driver' });
  assert.equal(wallet.activated, false);

  const activated = await service.activateDefaultWallet('driver-1', async (publicKey) => {
    assert.equal(publicKey, wallet.publicKey);
    return { txHash: 'tx-create-account' };
  });

  assert.equal(activated.activated, true);
  assert.equal(activated.activationTxHash, 'tx-create-account');
});

test('credits external deposits to a default wallet once', () => {
  const service = new WalletService({ keypairFactory: fakeFactory() });
  const wallet = service.provisionDefaultWallet({ userId: 'rider-1', role: 'rider' });
  const payment = {
    id: 'pay-1',
    txHash: 'tx-1',
    from: 'GEXTERNAL',
    to: wallet.publicKey,
    amount: '20',
    asset: { code: 'USDC', issuer: 'GISSUER' },
  };

  const first = service.creditExternalDeposit(payment);
  const second = service.creditExternalDeposit(payment);

  assert.equal(first.credited, true);
  assert.equal(first.balance, 20);
  assert.equal(second.credited, false);
  assert.equal(second.duplicate, true);
});

test('credits omnibus deposits by ORUVA memo and rejects unknown destinations', () => {
  const service = new WalletService({ keypairFactory: fakeFactory(), omnibusAddress: 'GOMNIBUS' });
  service.provisionDefaultWallet({ userId: 'driver-1', role: 'driver' });

  const credited = service.creditExternalDeposit({
    id: 'pay-2',
    from: 'GEXTERNAL',
    to: 'GOMNIBUS',
    amount: '5',
    memo: 'ORUVA:driver-1',
    asset: { code: 'XLM', issuer: null },
  });
  assert.equal(credited.credited, true);
  assert.equal(credited.deposit.userId, 'driver-1');

  assert.throws(() => service.creditExternalDeposit({
    id: 'pay-3',
    to: 'GUNKNOWN',
    amount: '1',
    asset: { code: 'XLM', issuer: null },
  }), /not an Oruva wallet/);
});
