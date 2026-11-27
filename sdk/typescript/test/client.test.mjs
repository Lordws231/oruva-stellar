import assert from 'node:assert/strict';
import test from 'node:test';
import { OruvaApiError, OruvaStellarIntentsClient } from '../src/index.ts';

test('SDK sends API key and generated idempotency key', async () => {
  const calls = [];
  const client = new OruvaStellarIntentsClient({
    baseUrl: 'https://api.example.test/',
    apiKey: 'test-api-key',
    idempotencyKeyFactory: () => 'generated-key-1',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return url.endsWith('/quote')
            ? { quoteId: 'quote-1', status: 'quoted', bestBid: {}, bids: [] }
            : { intentId: 'intent-1', status: 'open' };
        },
      };
    },
  });
  const quote = await client.quote({
    kind: 'swap_convert',
    userId: 'user-1',
    inputAsset: 'USDC',
    inputAmount: 100,
    outputAsset: 'USDC',
    outputChain: 'stellar',
    minOutputAmount: 95,
    recipient: 'GRECIPIENT',
    deadline: '2026-12-01T00:00:00.000Z',
  });
  assert.equal(quote.quoteId, 'quote-1');
  const submitted = await client.submit({ quoteId: quote.quoteId });
  assert.equal(submitted.intentId, 'intent-1');
  assert.equal(calls[0].init.headers['x-api-key'], 'test-api-key');
  assert.equal(calls[1].init.headers['idempotency-key'], 'generated-key-1');
  assert.equal(JSON.parse(calls[1].init.body).idempotencyKey, 'generated-key-1');
});

test('SDK status, refund and typed errors', async () => {
  const client = new OruvaStellarIntentsClient({
    baseUrl: 'https://api.example.test',
    apiKey: 'test-api-key',
    fetchImpl: async (url) => ({
      ok: !url.includes('missing'),
      status: url.includes('missing') ? 404 : 200,
      async json() {
        return url.includes('missing')
          ? { error: 'not found' }
          : { intentId: 'intent-1', status: url.endsWith('/refund') ? 'refunded' : 'open' };
      },
    }),
  });
  assert.equal((await client.status('intent-1')).status, 'open');
  assert.equal((await client.refund('intent-1')).status, 'refunded');
  await assert.rejects(client.status('missing'), (error) => {
    assert.equal(error instanceof OruvaApiError, true);
    assert.equal(error.status, 404);
    return true;
  });
});
