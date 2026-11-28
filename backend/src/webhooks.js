// Webhook delivery queue for Oruva Intents.
//
// Payloads are signed with HMAC SHA-256 using an injected secret
// provider. Transport is injected so delivery tests run offline. The
// queue records attempts and backoff state; a production worker would
// call deliverDue on a schedule and persist the same records.

import { createHmac } from 'node:crypto';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value;
}

async function resolveSecret(secretProvider) {
  const secret = typeof secretProvider === 'function' ? await secretProvider() : secretProvider;
  return requireText(secret, 'webhook secret');
}

export async function buildSignedWebhook({ event, secretProvider, now = new Date() }) {
  if (!event || typeof event !== 'object') throw new Error('webhook event is required');
  const timestamp = Math.floor(now.getTime() / 1000);
  const body = JSON.stringify(event);
  const secret = await resolveSecret(secretProvider);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-oruva-timestamp': String(timestamp),
      'x-oruva-signature': `sha256=${signature}`,
    },
  };
}

export class WebhookDeliveryQueue {
  constructor({
    transport,
    secretProvider,
    maxAttempts = 3,
    baseDelayMs = 1000,
    now = () => new Date(),
  } = {}) {
    if (!transport || typeof transport.post !== 'function') {
      throw new Error('transport.post is required');
    }
    this.transport = transport;
    this.secretProvider = secretProvider;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.now = now;
    this.deliveries = new Map();
    this.sequence = 0;
  }

  enqueue({ url, event }) {
    const delivery = {
      deliveryId: `webhook-${++this.sequence}`,
      url: requireText(url, 'url'),
      event,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: this.now().toISOString(),
      lastStatusCode: null,
      lastError: null,
      deliveredAt: null,
    };
    this.deliveries.set(delivery.deliveryId, delivery);
    return delivery;
  }

  async deliverDue(now = this.now()) {
    const results = [];
    for (const delivery of this.deliveries.values()) {
      if (delivery.status !== 'pending') continue;
      if (new Date(delivery.nextAttemptAt) > now) continue;
      results.push(await this.#attempt(delivery, now));
    }
    return results;
  }

  status(deliveryId) {
    const delivery = this.deliveries.get(requireText(deliveryId, 'deliveryId'));
    if (!delivery) throw new Error('webhook delivery not found');
    return delivery;
  }

  async #attempt(delivery, now) {
    const signed = await buildSignedWebhook({
      event: delivery.event,
      secretProvider: this.secretProvider,
      now,
    });
    delivery.attempts += 1;
    try {
      const response = await this.transport.post({
        url: delivery.url,
        headers: signed.headers,
        body: signed.body,
      });
      delivery.lastStatusCode = response?.status ?? null;
      if (delivery.lastStatusCode >= 200 && delivery.lastStatusCode < 300) {
        delivery.status = 'delivered';
        delivery.deliveredAt = now.toISOString();
        delivery.lastError = null;
        return delivery;
      }
      delivery.lastError = `webhook endpoint returned ${delivery.lastStatusCode}`;
    } catch (error) {
      delivery.lastStatusCode = null;
      delivery.lastError = error.message;
    }
    if (delivery.attempts >= this.maxAttempts) {
      delivery.status = 'failed';
    } else {
      const delay = this.baseDelayMs * (2 ** (delivery.attempts - 1));
      delivery.nextAttemptAt = new Date(now.getTime() + delay).toISOString();
    }
    return delivery;
  }
}
