import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiKeyStore } from '../src/apiKeys.js';
import { createTesterApi } from '../src/testerApi.js';

const testerRequest = {
  kind: 'swap_convert',
  inputAsset: 'USDC',
  inputAmount: 5,
  outputAsset: 'USDC',
  outputChain: 'stellar',
  minOutputAmount: 4,
  recipient: 'GRECIPIENT',
  deadline: '2026-12-01T00:00:00.000Z',
};

function keyed(apiKey) {
  return { headers: { 'x-api-key': apiKey } };
}

test('tester health declares testnet sandbox with no live money', () => {
  const api = createTesterApi();
  const health = api.health();
  assert.equal(health.network, 'stellar-testnet');
  assert.equal(health.mode, 'sandbox');
  assert.equal(health.liveMoney, false);
  assert.ok(health.routes.includes('POST /tester/v1/keys'));
});

test('developers self-issue sandbox keys and run a simulated settle', async () => {
  const api = createTesterApi();
  const issued = api.issueTesterKey({ body: { label: 'dev-one' } });
  assert.ok(issued.apiKey.startsWith('oruva_test_'));
  assert.equal(issued.key.sandbox, true);

  const quote = await api.quote({ ...keyed(issued.apiKey), body: testerRequest });
  assert.equal(quote.status, 'quoted');
  assert.equal(quote.sandbox, true);
  assert.equal(quote.intent.userId, `tester:${issued.key.id}`);

  const first = await api.submit({
    ...keyed(issued.apiKey),
    body: { quoteId: quote.quoteId, idempotencyKey: 'run-1' },
  });
  const again = await api.submit({
    ...keyed(issued.apiKey),
    body: { quoteId: quote.quoteId, idempotencyKey: 'run-1' },
  });
  assert.equal(first.intentId, again.intentId);

  const settled = api.simulateFill({ ...keyed(issued.apiKey), params: { intentId: first.intentId } });
  assert.equal(settled.status, 'settled');
  assert.ok(settled.txHashes.includes(`tester-settle-${first.intentId}`));

  const status = api.status({ ...keyed(issued.apiKey), params: { intentId: first.intentId } });
  assert.equal(status.status, 'settled');
});

test('tester sandbox caps amounts and rejects fiat payout', async () => {
  const api = createTesterApi();
  const issued = api.issueTesterKey({ body: { label: 'dev-two' } });
  await assert.rejects(
    api.quote({ ...keyed(issued.apiKey), body: { ...testerRequest, inputAmount: 11 } }),
    /exceeds cap/,
  );
  await assert.rejects(
    api.quote({ ...keyed(issued.apiKey), body: { ...testerRequest, outputAsset: 'NGN', outputChain: 'paystack_dva' } }),
    /fiat payout/,
  );
});

test('tester records are isolated per key and live keys are rejected', async () => {
  const store = new ApiKeyStore();
  const api = createTesterApi({ apiKeyStore: store });
  const one = api.issueTesterKey({ body: { label: 'dev-a' } });
  const two = api.issueTesterKey({ body: { label: 'dev-b' } });
  const quote = await api.quote({ ...keyed(one.apiKey), body: testerRequest });
  const record = await api.submit({
    ...keyed(one.apiKey),
    body: { quoteId: quote.quoteId, idempotencyKey: 'iso-1' },
  });
  assert.throws(
    () => api.status({ ...keyed(two.apiKey), params: { intentId: record.intentId } }),
    /intent not found/,
  );

  const live = store.issueKey({ scopes: ['intents:quote'], sandbox: false, label: 'live' });
  await assert.rejects(
    api.quote({ ...keyed(live.rawKey), body: testerRequest }),
    /sandbox_required/,
  );
});

test('registration requires terms and issues master credentials', async () => {
  const api = createTesterApi();
  assert.throws(
    () => api.register({ body: { name: 'Dev One', email: 'dev@example.com', acceptTerms: false } }),
    /terms acceptance/,
  );
  const account = api.register({
    body: { name: 'Dev One', email: 'Dev@Example.com', acceptTerms: true },
  });
  assert.ok(account.masterId.startsWith('oruva-dev-'));
  assert.equal(account.masterUrl, 'https://intents.oruva.com.ng/tester');
  assert.ok(account.masterKey.startsWith('oruva_test_'));
  assert.throws(
    () => api.register({ body: { name: 'Dev One', email: 'dev@example.com', acceptTerms: true } }),
    /already registered/,
  );

  const signedIn = api.signIn({ body: { masterId: account.masterId, masterKey: account.masterKey } });
  assert.equal(signedIn.ok, true);
  assert.equal(signedIn.email, 'dev@example.com');
  assert.throws(
    () => api.signIn({ body: { masterId: account.masterId, masterKey: 'oruva_test_wrong' } }),
    /invalid master credentials/,
  );

  const quote = await api.quote({ ...keyed(account.masterKey), body: testerRequest });
  assert.equal(quote.status, 'quoted');
});

test('tester refund after deadline and sandbox reset', async () => {
  const api = createTesterApi();
  const issued = api.issueTesterKey({ body: { label: 'dev-three' } });
  const quote = await api.quote({
    ...keyed(issued.apiKey),
    body: { ...testerRequest, deadline: '2026-11-01T00:00:00.000Z' },
  });
  const record = await api.submit({
    ...keyed(issued.apiKey),
    body: { quoteId: quote.quoteId, idempotencyKey: 'refund-1' },
  });
  const refunded = api.refund({ ...keyed(issued.apiKey), params: { intentId: record.intentId } });
  assert.equal(refunded.status, 'refunded');

  const reset = api.reset(keyed(issued.apiKey));
  assert.equal(reset.removedIntents, 1);
  assert.throws(
    () => api.status({ ...keyed(issued.apiKey), params: { intentId: record.intentId } }),
    /intent not found/,
  );
});
