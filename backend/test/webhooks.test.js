import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { WebhookDeliveryQueue, buildSignedWebhook } from '../src/webhooks.js';

const event = {
  type: 'intent_settled',
  intentId: 'intent-1',
  status: 'settled',
  kind: 'swap_convert',
};

test('signed webhook payload uses HMAC from injected secret provider', async () => {
  const now = new Date('2026-11-27T21:00:00.000Z');
  const signed = await buildSignedWebhook({
    event,
    secretProvider: async () => 'test-only-secret',
    now,
  });
  const expected = createHmac('sha256', 'test-only-secret')
    .update(`${Math.floor(now.getTime() / 1000)}.${signed.body}`)
    .digest('hex');
  assert.equal(signed.headers['x-oruva-signature'], `sha256=${expected}`);
  assert.equal(JSON.parse(signed.body).intentId, 'intent-1');
});

test('webhook queue retries with backoff and tracks delivery', async () => {
  let calls = 0;
  const queue = new WebhookDeliveryQueue({
    transport: {
      async post() {
        calls += 1;
        return { status: calls === 1 ? 500 : 204 };
      },
    },
    secretProvider: async () => 'test-only-secret',
    baseDelayMs: 1000,
    now: () => new Date('2026-11-27T21:00:00.000Z'),
  });
  const delivery = queue.enqueue({ url: 'https://example.test/webhook', event });
  const first = await queue.deliverDue(new Date('2026-11-27T21:00:00.000Z'));
  assert.equal(first[0].status, 'pending');
  assert.equal(first[0].attempts, 1);
  assert.equal(first[0].nextAttemptAt, '2026-11-27T21:00:01.000Z');
  const early = await queue.deliverDue(new Date('2026-11-27T21:00:00.500Z'));
  assert.equal(early.length, 0);
  const second = await queue.deliverDue(new Date('2026-11-27T21:00:01.000Z'));
  assert.equal(second[0].status, 'delivered');
  assert.equal(queue.status(delivery.deliveryId).lastStatusCode, 204);
});

test('webhook queue marks delivery failed after max attempts', async () => {
  const queue = new WebhookDeliveryQueue({
    transport: { async post() { return { status: 503 }; } },
    secretProvider: async () => 'test-only-secret',
    maxAttempts: 2,
    baseDelayMs: 10,
    now: () => new Date('2026-11-27T21:00:00.000Z'),
  });
  const delivery = queue.enqueue({ url: 'https://example.test/webhook', event });
  await queue.deliverDue(new Date('2026-11-27T21:00:00.000Z'));
  await queue.deliverDue(new Date('2026-11-27T21:00:00.010Z'));
  assert.equal(queue.status(delivery.deliveryId).status, 'failed');
});
