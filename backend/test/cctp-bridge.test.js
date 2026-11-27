import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CctpBridgeAdapter,
  cctpAttestationPath,
  cctpFeeQuotePath,
} from '../src/cctpBridge.js';

function fakeTransport() {
  return {
    feePaths: [],
    burnCalls: 0,
    attestationCalls: 0,
    async getFeeQuote(path) {
      this.feePaths.push(path);
      return [{ finalityThreshold: 2000, minimumFee: 10, forwardFee: 12345 }];
    },
    async submitBurn() {
      this.burnCalls += 1;
      return { burnHash: 'stellar-burn-hash' };
    },
    async getAttestation(path) {
      this.attestationCalls += 1;
      assert.equal(path, '/v2/messages/27?transactionHash=stellar-burn-hash');
      if (this.attestationCalls === 1) {
        return { status: 'pending', forwardState: null, forwardTxHash: null };
      }
      return { status: 'complete', forwardState: 'CONFIRMED', forwardTxHash: 'polygon-mint-hash' };
    },
  };
}

const quoteRequest = {
  payoutId: 'payout-1',
  rideId: 'ride-1',
  amountUsdc: 12.5,
  mintRecipient: '0x1111111111111111111111111111111111111111',
  conversionReference: 'conversion-1',
};

test('CCTP quote uses Stellar domain 27 to Polygon domain 7 fee shape', async () => {
  assert.equal(cctpFeeQuotePath(), '/v2/burn/USDC/fees/27/7?forward=true');
  assert.equal(
    cctpAttestationPath({ burnHash: 'abc' }),
    '/v2/messages/27?transactionHash=abc',
  );
  const transport = fakeTransport();
  const adapter = new CctpBridgeAdapter({ transport });
  const record = await adapter.quote(quoteRequest);
  assert.equal(record.status, 'quoted');
  assert.equal(record.quote.endpoint, '/v2/burn/USDC/fees/27/7?forward=true');
  assert.equal(record.quote.maxFee7, (12500 + 12345) * 10);
  const again = await adapter.quote(quoteRequest);
  assert.equal(again, record);
  await assert.rejects(
    adapter.quote({ ...quoteRequest, amountUsdc: 13 }),
    /different bridge terms/,
  );
});

test('CCTP burn, attestation and mint states move once', async () => {
  const transport = fakeTransport();
  const adapter = new CctpBridgeAdapter({ transport });
  await adapter.quote(quoteRequest);
  const burned = await adapter.submitBurn('payout-1');
  assert.equal(burned.status, 'burned');
  await assert.rejects(adapter.submitBurn('payout-1'), /already submitted/);
  assert.equal(transport.burnCalls, 1);
  const attesting = await adapter.pollAttestation('payout-1');
  assert.equal(attesting.status, 'attesting');
  const minted = await adapter.pollAttestation('payout-1');
  assert.equal(minted.status, 'minted');
  assert.equal(minted.mintHash, 'polygon-mint-hash');
  const completed = adapter.recordFinalCredit('payout-1', {
    finalCreditReference: 'dva-credit-1',
  });
  assert.equal(completed.status, 'completed');
});

test('CCTP reconciliation record links ride, hashes and references', async () => {
  const adapter = new CctpBridgeAdapter({ transport: fakeTransport() });
  await adapter.quote(quoteRequest);
  await adapter.submitBurn('payout-1');
  await adapter.pollAttestation('payout-1');
  await adapter.pollAttestation('payout-1');
  adapter.recordFinalCredit('payout-1', { finalCreditReference: 'dva-credit-1' });
  const record = adapter.reconciliationRecord('payout-1');
  assert.equal(record.rideId, 'ride-1');
  assert.equal(record.burnHash, 'stellar-burn-hash');
  assert.equal(record.mintHash, 'polygon-mint-hash');
  assert.equal(record.conversionReference, 'conversion-1');
  assert.equal(record.finalCreditReference, 'dva-credit-1');
  assert.equal(record.destinationDomain, 7);
});
