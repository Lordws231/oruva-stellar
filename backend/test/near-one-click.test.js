import assert from 'node:assert/strict';
import test from 'node:test';
import { IntentService, NearOneClickRouteAdapter } from '../src/intents.js';
import { NearOneClickClient, assertXrplAssetSupported } from '../src/nearOneClick.js';

const request = {
  kind: 'cross_chain_payout',
  userId: 'user-1',
  inputAsset: 'USDC',
  inputChain: 'stellar',
  inputAmount: 100,
  outputAsset: 'XRP',
  outputChain: 'xrpl',
  minOutputAmount: 90,
  recipient: 'rRecipient',
  deadline: '2026-12-01T00:00:00.000Z',
};

const liveQuote = {
  quoteId: 'near-quote-1',
  depositAddress: 'deposit-address',
  outputAmount: 97,
  feeAmount: 1.5,
  spreadBps: 25,
  slippageBps: 50,
  minimumOut: 96,
  refundPath: 'refund_to_source_wallet',
};

test('1Click client hides route without a complete live quote', async () => {
  const noTransport = new NearOneClickClient();
  assert.equal(await noTransport.quote(request), null);
  const incomplete = new NearOneClickClient({
    transport: { async quote() { return { quoteId: 'x' }; } },
  });
  assert.equal(await incomplete.quote(request), null);
});

test('1Click client records quote and delivery references', async () => {
  const client = new NearOneClickClient({
    transport: { async quote() { return liveQuote; } },
  });
  const quote = await client.quote(request);
  assert.equal(quote.quoteId, 'near-quote-1');
  assert.equal(quote.minimumOut, 96);
  client.recordSourceTx('near-quote-1', 'stellar-source-tx');
  client.recordSolverDeliveryTx('near-quote-1', 'xrpl-delivery-tx');
  const record = client.getQuote('near-quote-1');
  assert.equal(record.sourceTx, 'stellar-source-tx');
  assert.equal(record.solverDeliveryTx, 'xrpl-delivery-tx');
  assert.equal(record.refundPath, 'refund_to_source_wallet');
});

test('NEAR route adapter uses the 1Click client evidence', async () => {
  const client = new NearOneClickClient({
    transport: { async quote() { return liveQuote; } },
  });
  const service = new IntentService({
    routeAdapters: [new NearOneClickRouteAdapter({ client })],
  });
  const quote = await service.quote(request);
  assert.equal(quote.status, 'quoted');
  assert.equal(quote.bestBid.evidence.quoteId, 'near-quote-1');
  assert.equal(quote.bestBid.evidence.fees.slippageBps, 50);
});

test('XRPL asset care rejects USDT as native', async () => {
  assert.throws(() => assertXrplAssetSupported('USDT', 'xrpl'), /not native/);
  assert.doesNotThrow(() => assertXrplAssetSupported('XRP', 'xrpl'));
  assert.doesNotThrow(() => assertXrplAssetSupported('RLUSD', 'xrpl'));
  const client = new NearOneClickClient({
    transport: { async quote() { return liveQuote; } },
  });
  assert.equal(await client.quote({ ...request, outputAsset: 'USDT' }), null);
});
