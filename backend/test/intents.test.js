import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiKeyRateLimiter,
  CctpRouteAdapter,
  FlutterwaveAnchorRouteAdapter,
  IntentService,
  NearOneClickRouteAdapter,
  StellarDexRouteAdapter,
  createIntentApiHandlers,
  selectBestBid,
} from '../src/intents.js';

const baseRequest = {
  kind: 'swap_convert',
  userId: 'user-1',
  inputAsset: 'USDC',
  inputAmount: 100,
  outputAsset: 'USDC',
  outputChain: 'stellar',
  minOutputAmount: 95,
  recipient: 'GRECIPIENT',
  deadline: '2026-12-01T00:00:00.000Z',
};

test('best bid selection picks highest eligible output', () => {
  const best = selectBestBid([
    { solver: 'b', outputAmount: 96 },
    { solver: 'a', outputAmount: 99 },
    { solver: 'c', outputAmount: 90 },
  ], 95);
  assert.equal(best.solver, 'a');
});

test('quote, idempotent submit, settle and evidence pack', async () => {
  const service = new IntentService({ routeAdapters: [new StellarDexRouteAdapter()] });
  const quote = await service.quote(baseRequest);
  assert.equal(quote.status, 'quoted');
  const first = await service.submit({ quoteId: quote.quoteId, idempotencyKey: 'key-1' });
  const second = await service.submit({ quoteId: quote.quoteId, idempotencyKey: 'key-1' });
  assert.equal(first.intentId, second.intentId);
  service.transition(first.intentId, 'filled', { txHash: 'tx-fill' });
  service.transition(first.intentId, 'settled', { txHash: 'tx-settle' });
  const pack = service.evidencePack(first.intentId);
  assert.deepEqual(pack.txHashes, ['tx-fill', 'tx-settle']);
  assert.equal(pack.balances.outputDelivered, first.selectedBid.outputAmount);
  assert.throws(() => service.transition(first.intentId, 'settled'), /already settled/);
});

test('NEAR 1Click route is hidden without a live quote', async () => {
  const service = new IntentService({ routeAdapters: [new NearOneClickRouteAdapter()] });
  const quote = await service.quote({ ...baseRequest, outputChain: 'xrpl', outputAsset: 'XRP' });
  assert.equal(quote.status, 'no_route');
  assert.equal(quote.bids.length, 0);
});

test('CCTP route quotes Stellar USDC to Polygon only', async () => {
  const service = new IntentService({ routeAdapters: [new CctpRouteAdapter()] });
  const quote = await service.quote({ ...baseRequest, outputChain: 'polygon' });
  assert.equal(quote.bestBid.route, 'cctp_stellar_to_polygon');
});

test('Flutterwave fiat route stays unavailable until gates clear', async () => {
  const service = new IntentService({ routeAdapters: [new FlutterwaveAnchorRouteAdapter()] });
  const quote = await service.quote({ ...baseRequest, outputAsset: 'NGN', outputChain: 'paystack_dva' });
  assert.equal(quote.status, 'no_route');
});

test('refund requires deadline to pass', async () => {
  const service = new IntentService({ routeAdapters: [new StellarDexRouteAdapter()] });
  const quote = await service.quote(baseRequest);
  const record = await service.submit({ quoteId: quote.quoteId, idempotencyKey: 'key-2' });
  assert.throws(() => service.refund(record.intentId, new Date('2026-11-30T00:00:00.000Z')), /deadline/);
  const refunded = service.refund(record.intentId, new Date('2026-12-02T00:00:00.000Z'));
  assert.equal(refunded.status, 'refunded');
});

test('agent payment spend limit is enforced at quote time', async () => {
  const service = new IntentService({ routeAdapters: [new StellarDexRouteAdapter()] });
  await assert.rejects(
    service.quote({ ...baseRequest, kind: 'agent_payment', spendLimit: 50 }),
    /spendLimit/,
  );
});

test('API handlers require a key and enforce rate limits', async () => {
  const service = new IntentService({ routeAdapters: [new StellarDexRouteAdapter()] });
  const handlers = createIntentApiHandlers({
    service,
    rateLimiter: new ApiKeyRateLimiter({ limit: 1, windowMs: 60000 }),
  });
  await assert.rejects(handlers.quote({ headers: {}, body: baseRequest }), /apiKey/);
  const quote = await handlers.quote({ headers: { 'x-api-key': 'test-key' }, body: baseRequest });
  assert.equal(quote.status, 'quoted');
  await assert.rejects(
    handlers.quote({ headers: { 'x-api-key': 'test-key' }, body: baseRequest }),
    /rate limit/,
  );
});
