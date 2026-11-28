import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCctpMessage,
  verifyCctpDeliveryProof,
  verifyDeliveryProof,
  verifyNearDeliveryProof,
} from '../src/deliveryProof.js';
import {
  CctpRouteAdapter,
  IntentService,
  NearOneClickRouteAdapter,
} from '../src/intents.js';
import { NearOneClickClient } from '../src/nearOneClick.js';

const polygonRecipient = '0x1111111111111111111111111111111111111111';
const burner = '0x2222222222222222222222222222222222222222';
const attestation = `0x${'ab'.repeat(64)}1b`;

const cctpIntent = {
  kind: 'cross_chain_payout',
  userId: 'user-1',
  inputAsset: 'USDC',
  inputAmount: 100,
  outputAsset: 'USDC',
  outputChain: 'polygon',
  minOutputAmount: 95,
  recipient: polygonRecipient,
  deadline: '2026-12-01T00:00:00.000Z',
};

function cctpEvidence(overrides = {}) {
  return {
    route: 'cctp_stellar_to_polygon',
    message: {
      sourceDomain: 27,
      destinationDomain: 7,
      nonce: 42,
      sender: burner,
      mintRecipient: polygonRecipient,
      amount: 99,
    },
    attestation,
    attestationStatus: 'complete',
    burnTxHash: 'stellar-burn-hash',
    mint: { txHash: 'polygon-mint-hash', amount: 99, recipient: polygonRecipient },
    ...overrides,
  };
}

function paddedAddress(address) {
  return Buffer.concat([
    Buffer.alloc(12),
    Buffer.from(address.replace(/^0x/, ''), 'hex'),
  ]);
}

function cctpMessageHex() {
  const header = Buffer.alloc(116);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(27, 4);
  header.writeUInt32BE(7, 8);
  header.writeBigUInt64BE(42n, 12);
  Buffer.alloc(32, 7).copy(header, 20);
  Buffer.alloc(32, 8).copy(header, 52);
  const body = Buffer.alloc(132);
  body.writeUInt32BE(1, 0);
  Buffer.alloc(32, 9).copy(body, 4);
  paddedAddress(polygonRecipient).copy(body, 36);
  let amount = 99_000_000n;
  for (let index = 99; index >= 68; index -= 1) {
    body[index] = Number(amount & 0xffn);
    amount >>= 8n;
  }
  paddedAddress(burner).copy(body, 100);
  return `0x${Buffer.concat([header, body]).toString('hex')}`;
}

const nearIntent = {
  kind: 'cross_chain_payout',
  userId: 'user-1',
  inputAsset: 'USDC',
  inputAmount: 100,
  outputAsset: 'XRP',
  outputChain: 'xrpl',
  minOutputAmount: 90,
  recipient: 'rRecipient',
  deadline: '2026-12-01T00:00:00.000Z',
};

function nearTransport(result) {
  return {
    calls: [],
    async getDeliveryStatus(request) {
      this.calls.push(request);
      return result;
    },
  };
}

test('CCTP proof verifies a bound message, attestation and mint', () => {
  const proof = verifyCctpDeliveryProof({ intent: cctpIntent, evidence: cctpEvidence() });
  assert.equal(proof.verified, true);
  assert.equal(proof.amount, 99);
  assert.equal(proof.mintTxHash, 'polygon-mint-hash');
  assert.equal(proof.nonce, '42');
});

test('CCTP proof parses hex message fixtures', () => {
  const message = parseCctpMessage(cctpMessageHex());
  assert.equal(message.sourceDomain, 27);
  assert.equal(message.destinationDomain, 7);
  assert.equal(message.amount, 99);
  const proof = verifyCctpDeliveryProof({
    intent: cctpIntent,
    evidence: cctpEvidence({ message: cctpMessageHex() }),
  });
  assert.equal(proof.verified, true);
});

test('CCTP proof rejects mismatched amount, recipient and domain', () => {
  assert.throws(
    () => verifyCctpDeliveryProof({
      intent: cctpIntent,
      evidence: cctpEvidence({
        mint: { txHash: 'polygon-mint-hash', amount: 98, recipient: polygonRecipient },
      }),
    }),
    /amount mismatch/,
  );
  assert.throws(
    () => verifyCctpDeliveryProof({
      intent: cctpIntent,
      evidence: cctpEvidence({
        mint: {
          txHash: 'polygon-mint-hash',
          amount: 99,
          recipient: '0x3333333333333333333333333333333333333333',
        },
      }),
    }),
    /recipient mismatch/,
  );
  assert.throws(
    () => verifyCctpDeliveryProof({
      intent: cctpIntent,
      evidence: cctpEvidence({
        message: {
          sourceDomain: 27,
          destinationDomain: 6,
          nonce: 42,
          sender: burner,
          mintRecipient: polygonRecipient,
          amount: 99,
        },
      }),
    }),
    /destination domain mismatch/,
  );
});

test('CCTP proof rejects missing or malformed attestation', () => {
  assert.throws(
    () => verifyCctpDeliveryProof({
      intent: cctpIntent,
      evidence: cctpEvidence({ attestation: null }),
    }),
    /attestation is required/,
  );
  assert.throws(
    () => verifyCctpDeliveryProof({
      intent: cctpIntent,
      evidence: cctpEvidence({ attestation: '0x1234' }),
    }),
    /attestation format is invalid/,
  );
  assert.throws(
    () => verifyCctpDeliveryProof({
      intent: cctpIntent,
      evidence: cctpEvidence({ attestationStatus: 'pending' }),
    }),
    /attestation is not complete/,
  );
});

test('CCTP solver reference alone does not verify', async () => {
  await assert.rejects(
    verifyDeliveryProof({
      intent: cctpIntent,
      selectedBid: { route: 'cctp_stellar_to_polygon' },
      evidence: { route: 'cctp_stellar_to_polygon', txHash: 'solver-claimed-mint' },
    }),
    /CCTP message is required|sourceDomain|attestation/,
  );
});

test('NEAR proof accepts only completed delivery with matching terms', async () => {
  const transport = nearTransport({
    status: 'SUCCESS',
    deliveredAmount: 97,
    recipient: 'rRecipient',
    quoteId: 'near-quote-1',
    deliveryTxHash: 'xrpl-delivery-tx',
  });
  const proof = await verifyNearDeliveryProof({
    intent: nearIntent,
    evidence: { quoteId: 'near-quote-1', solverDeliveryTx: 'xrpl-delivery-tx' },
    transport,
  });
  assert.equal(proof.verified, true);
  assert.equal(proof.amount, 97);
  assert.equal(transport.calls.length, 1);
});

test('NEAR proof rejects pending, failed and mismatched delivery', async () => {
  const evidence = { quoteId: 'near-quote-1', solverDeliveryTx: 'xrpl-delivery-tx' };
  await assert.rejects(
    verifyNearDeliveryProof({
      intent: nearIntent,
      evidence,
      transport: nearTransport({ status: 'pending', deliveredAmount: 97, recipient: 'rRecipient' }),
    }),
    /not complete/,
  );
  await assert.rejects(
    verifyNearDeliveryProof({
      intent: nearIntent,
      evidence,
      transport: nearTransport({ status: 'failed', deliveredAmount: 97, recipient: 'rRecipient' }),
    }),
    /not complete/,
  );
  await assert.rejects(
    verifyNearDeliveryProof({
      intent: nearIntent,
      evidence,
      transport: nearTransport({ status: 'completed', deliveredAmount: 97, recipient: 'rOther' }),
    }),
    /recipient mismatch/,
  );
  await assert.rejects(
    verifyNearDeliveryProof({
      intent: nearIntent,
      evidence: { ...evidence, amount: 96 },
      transport: nearTransport({ status: 'completed', deliveredAmount: 97, recipient: 'rRecipient' }),
    }),
    /amount mismatch/,
  );
  await assert.rejects(
    verifyNearDeliveryProof({ intent: nearIntent, evidence, transport: null }),
    /transport is required/,
  );
});

test('cross-chain CCTP settlement requires verified delivery proof', async () => {
  const service = new IntentService({ routeAdapters: [new CctpRouteAdapter()] });
  const quote = await service.quote(cctpIntent);
  const record = await service.submit({ quoteId: quote.quoteId, idempotencyKey: 'cctp-1' });
  service.transition(record.intentId, 'filled', { txHash: 'stellar-burn-hash' });
  assert.throws(
    () => service.transition(record.intentId, 'settled', { txHash: 'solver-claimed-mint' }),
    /verified delivery proof/,
  );
  assert.equal(service.status(record.intentId).status, 'filled');
  const settled = await service.settleWithDeliveryProof(record.intentId, cctpEvidence());
  assert.equal(settled.status, 'settled');
  assert.equal(settled.deliveryProof.mintTxHash, 'polygon-mint-hash');
  assert.deepEqual(settled.txHashes, ['stellar-burn-hash', 'polygon-mint-hash']);
});

test('cross-chain NEAR settlement verifies delivery before settling', async () => {
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
  const client = new NearOneClickClient({
    transport: { async quote() { return liveQuote; } },
  });
  const transport = nearTransport({
    status: 'pending',
    deliveredAmount: 97,
    recipient: 'rRecipient',
    quoteId: 'near-quote-1',
  });
  const service = new IntentService({
    routeAdapters: [new NearOneClickRouteAdapter({ client })],
    deliveryTransports: { near: transport },
  });
  const quote = await service.quote(nearIntent);
  const record = await service.submit({ quoteId: quote.quoteId, idempotencyKey: 'near-1' });
  service.transition(record.intentId, 'filled', { solverDeliveryTx: 'xrpl-delivery-tx' });
  assert.throws(
    () => service.transition(record.intentId, 'settled', { txHash: 'xrpl-delivery-tx' }),
    /verified delivery proof/,
  );
  await assert.rejects(
    service.settleWithDeliveryProof(record.intentId, { solverDeliveryTx: 'xrpl-delivery-tx' }),
    /not complete/,
  );
  assert.equal(service.status(record.intentId).status, 'filled');
  transport.getDeliveryStatus = async () => ({
    status: 'completed',
    deliveredAmount: 97,
    recipient: 'rRecipient',
    quoteId: 'near-quote-1',
    deliveryTxHash: 'xrpl-delivery-tx',
  });
  const settled = await service.settleWithDeliveryProof(record.intentId, {
    solverDeliveryTx: 'xrpl-delivery-tx',
  });
  assert.equal(settled.status, 'settled');
  assert.equal(settled.deliveryProof.deliveryTxHash, 'xrpl-delivery-tx');
});
