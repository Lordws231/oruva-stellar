import assert from 'node:assert/strict';
import test from 'node:test';
import { createTesterHttpServer } from '../src/server.js';

async function withServer(run) {
  const server = createTesterHttpServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('tester server serves health, dashboard and docs', async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/tester/v1/health`).then((r) => r.json());
    assert.equal(health.network, 'stellar-testnet');
    assert.equal(health.liveMoney, false);

    const home = await fetch(`${base}/`).then((r) => r.text());
    assert.match(home, /State your outcome/);
    assert.match(home, /Register for Oruva Intents/);
    assert.match(home, /Sign in to Oruva Intents/);
    assert.match(home, /Master Key/);
    assert.match(home, /2026 Oruva Intents/);
    assert.equal(home.includes('—'), false);

    const register = await fetch(`${base}/register`).then((r) => r.text());
    assert.match(register, /Register &amp; Generate Master Credentials/);
    const signin = await fetch(`${base}/signin`).then((r) => r.text());
    assert.match(signin, /Welcome back/);

    const terms = await fetch(`${base}/terms.html`).then((r) => r.text());
    assert.match(terms, /Tester Terms and Policy/);

    const docs = await fetch(`${base}/docs.html`).then((r) => r.text());
    assert.match(docs, /Tester Docs/);

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
  });
});

test('tester server runs the full sandbox flow over HTTP', async () => {
  await withServer(async (base) => {
    const rejected = await fetch(`${base}/tester/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Http Dev', email: 'http@example.com', acceptTerms: false }),
    });
    assert.equal(rejected.status, 400);

    const account = await fetch(`${base}/tester/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Http Dev', email: 'http@example.com', acceptTerms: true }),
    }).then((r) => r.json());
    assert.ok(account.masterId.startsWith('oruva-dev-'));
    assert.ok(account.masterKey.startsWith('oruva_test_'));

    const signedIn = await fetch(`${base}/tester/v1/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ masterId: account.masterId, masterKey: account.masterKey }),
    }).then((r) => r.json());
    assert.equal(signedIn.ok, true);

    const headers = { 'content-type': 'application/json', 'x-api-key': account.masterKey };

    const quote = await fetch(`${base}/tester/v1/intents/quote`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'swap_convert',
        inputAsset: 'USDC',
        inputAmount: 5,
        outputAsset: 'USDC',
        outputChain: 'stellar',
        minOutputAmount: 4,
        recipient: 'GRECIPIENT',
        deadline: '2026-12-01T00:00:00.000Z',
      }),
    }).then((r) => r.json());
    assert.equal(quote.status, 'quoted');

    const record = await fetch(`${base}/tester/v1/intents/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ quoteId: quote.quoteId, idempotencyKey: 'http-1' }),
    }).then((r) => r.json());
    assert.equal(record.status, 'open');

    const settled = await fetch(`${base}/tester/v1/intents/${record.intentId}/simulate-fill`, {
      method: 'POST',
      headers,
      body: '{}',
    }).then((r) => r.json());
    assert.equal(settled.status, 'settled');
  });
});
