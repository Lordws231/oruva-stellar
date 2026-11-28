import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { VerifierLedger, VERIFYING_CONTRACT } from '../src/ledger.js';
import { SolverRelay } from '../src/relay.js';
import { createSwapApi } from '../src/swapApi.js';
import { createEd25519Signer, signIntent } from '../src/sep53.js';

const XLM = 'stellar:XLM';
const USDC = 'stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

test('verifier ledger settles token_diff atomically and blocks nonce replay', () => {
  const ledger = new VerifierLedger();
  ledger.deposit('alice', XLM, '100000000');
  ledger.deposit('solver', USDC, '100000000');
  const payload = {
    signer_id: 'alice',
    verifying_contract: VERIFYING_CONTRACT,
    deadline: new Date(Date.now() + 60000).toISOString(),
    nonce: Buffer.alloc(32, 7).toString('base64'),
    intents: [
      {
        type: 'token_diff',
        diffs: [
          { signer_id: 'alice', diff: { [XLM]: '-50000000', [USDC]: '6000000' } },
          { signer_id: 'solver', diff: { [XLM]: '50000000', [USDC]: '-6000000' } },
        ],
      },
    ],
  };
  const result = ledger.executeIntents(payload);
  assert.equal(result.executed, 1);
  assert.equal(ledger.balanceOf('alice', USDC), '6000000');
  assert.throws(() => ledger.executeIntents(payload), /nonce already used/);

  const bad = {
    ...payload,
    nonce: Buffer.alloc(32, 8).toString('base64'),
    intents: [
      {
        type: 'token_diff',
        diffs: [
          { signer_id: 'alice', diff: { [XLM]: '-999999999' } },
          { signer_id: 'solver', diff: { [XLM]: '999999999' } },
        ],
      },
    ],
  };
  assert.throws(() => ledger.executeIntents(bad), /insufficient ledger balance/);
  assert.equal(ledger.balanceOf('alice', XLM), '50000000');
});

test('solver relay picks the best quote and survives a slow solver', async () => {
  const relay = new SolverRelay({ quoteTimeoutMs: 50 });
  relay.registerSolver({ id: 'slow', quote: () => new Promise((resolve) => setTimeout(() => resolve({ amountOut: '999' }), 200)) });
  relay.registerSolver({ id: 'fast', quote: async () => ({ amountOut: '100' }) });
  relay.registerSolver({ id: 'better', quote: async () => ({ amountOut: '120' }) });
  const options = await relay.quote({ originAsset: XLM, destinationAsset: USDC, amountIn: '100' });
  assert.equal(options[0].solverId, 'better');
  assert.equal(options.length, 2);
});

test('swap quote dry and committed shapes, deposit lifecycle to SUCCESS', async () => {
  const api = createSwapApi();
  const dry = await api.quote({
    ownerId: 'dev-1',
    body: { dry: true, originAsset: XLM, destinationAsset: USDC, amount: '50000000' },
  });
  assert.equal(dry.dry, true);
  assert.equal(dry.depositAddress, undefined);
  assert.ok(BigInt(dry.amountOut) > 0n);
  assert.ok(dry.fees.totalFeeBps > 0);

  const committed = await api.quote({
    ownerId: 'dev-1',
    body: { originAsset: XLM, destinationAsset: USDC, amount: '50000000', insured: true },
  });
  assert.equal(committed.depositAddress, 'oruva-testnet-deposit');
  assert.ok(committed.depositMemo);
  assert.ok(committed.signature);
  assert.equal(committed.fees.insuredFeeBps, 2);

  const partial = api.depositSubmit({
    ownerId: 'dev-1',
    body: { depositAddress: committed.depositAddress, depositMemo: committed.depositMemo, amount: '20000000' },
  });
  assert.equal(partial.status, 'INCOMPLETE_DEPOSIT');

  const done = api.depositSubmit({
    ownerId: 'dev-1',
    body: { depositAddress: committed.depositAddress, depositMemo: committed.depositMemo, amount: '30000000' },
  });
  assert.equal(done.status, 'SUCCESS');
  assert.ok(done.txHash);
  assert.equal(api.status({ ownerId: 'dev-1', depositMemo: committed.depositMemo }).status, 'SUCCESS');
});

test('EXACT_OUTPUT quote buffers input and deadline refunds an unpaid swap', async () => {
  let clock = new Date('2026-11-28T12:00:00.000Z');
  const api = createSwapApi({ now: () => clock });
  const quote = await api.quote({
    ownerId: 'dev-2',
    body: {
      swapType: 'EXACT_OUTPUT',
      originAsset: XLM,
      destinationAsset: USDC,
      amount: '6000000',
      deadline: '2026-11-28T12:05:00.000Z',
    },
  });
  assert.ok(BigInt(quote.amountIn) >= BigInt(quote.minAmountIn));
  clock = new Date('2026-11-28T12:06:00.000Z');
  assert.equal(api.status({ ownerId: 'dev-2', depositMemo: quote.depositMemo }).status, 'REFUNDED');
});

test('signed intent execution settles ledger balances with SEP-53', async () => {
  const ledger = new VerifierLedger();
  const api = createSwapApi({ ledger });
  ledger.deposit('user-1', XLM, '50000000');
  const quote = await api.quote({
    ownerId: 'user-1',
    body: { originAsset: XLM, destinationAsset: USDC, amount: '50000000', depositType: 'INTENTS' },
  });
  const generated = api.generateIntent({
    ownerId: 'user-1',
    body: { depositMemo: quote.depositMemo, signerId: 'user-1' },
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const signed = await signIntent(generated.payload, createEd25519Signer(privateKey));
  const submitted = api.submitIntent({
    ownerId: 'user-1',
    body: {
      depositMemo: quote.depositMemo,
      payload: generated.payload,
      signature: signed.signatureHex,
      publicKey: rawPublic.toString('hex'),
    },
  });
  assert.equal(submitted.status, 'SUCCESS');
  assert.ok(submitted.intentHash);
  assert.equal(ledger.balanceOf('user-1', XLM), '0');
  assert.ok(BigInt(ledger.balanceOf('user-1', USDC)) > 0n);
});

test('all-chain catalog quotes cross-chain pairs with route classification', async () => {
  const api = createSwapApi();
  const catalog = api.tokens();
  assert.ok(catalog.tokens.length >= 30);
  assert.ok(catalog.chains.length >= 15);

  const btcQuote = await api.quote({
    ownerId: 'dev-4',
    body: { dry: true, originAsset: 'bitcoin:BTC', destinationAsset: 'ethereum:USDC', amount: '100000' },
  });
  assert.ok(BigInt(btcQuote.amountOut) > 0n);
  assert.equal(btcQuote.route, 'external-route-simulated');

  const cctpQuote = await api.quote({
    ownerId: 'dev-4',
    body: { dry: true, originAsset: USDC, destinationAsset: 'base:USDC', amount: '50000000' },
  });
  assert.equal(cctpQuote.route, 'cctp-testnet-route');

  const dynamicQuote = await api.quote({
    ownerId: 'dev-4',
    body: { dry: true, originAsset: 'arbitrum:DAI', destinationAsset: 'solana:SOL', amount: '5000000' },
  });
  assert.ok(BigInt(dynamicQuote.amountOut) > 0n);

  await assert.rejects(
    api.quote({
      ownerId: 'dev-4',
      body: { dry: true, originAsset: 'ethereum:UNKNOWNCOIN', destinationAsset: 'ethereum:USDC', amount: '1000' },
    }),
    /no solver route/,
  );
});

test('limit order partial fill then cancel refunds the remainder', () => {
  const api = createSwapApi();
  const order = api.createOrder({
    ownerId: 'dev-3',
    body: { originAsset: XLM, destinationAsset: USDC, amountIn: '50000000', limitAmountOut: '6000000' },
  });
  assert.equal(order.status, 'AWAITING_DEPOSIT');
  assert.equal(api.fundOrder({ ownerId: 'dev-3', orderId: order.orderId, body: { amount: '50000000' } }).status, 'OPEN');
  const partial = api.simulateFillOrder({
    ownerId: 'dev-3',
    orderId: order.orderId,
    body: { fillAmountOut: '3000000' },
  });
  assert.equal(partial.status, 'PARTIALLY_FILLED');
  const canceled = api.cancelOrder({ ownerId: 'dev-3', orderId: order.orderId });
  assert.equal(canceled.status, 'CANCELED');
  assert.equal(canceled.refundAmount, '25000000');
  assert.equal(api.listOrders({ ownerId: 'dev-3' }).orders.length, 1);
});
