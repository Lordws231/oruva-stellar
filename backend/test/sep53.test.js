import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  buildIntentSigningPayload,
  canonicalJson,
  createEd25519Signer,
  rawPublicKeyToStellarAddress,
  signIntent,
  signSep53Message,
  verifyIntentSignature,
  verifySep53Message,
} from '../src/sep53.js';

const intent = {
  kind: 'cross_chain_payout',
  inputAsset: 'USDC',
  inputAmount: 100,
  outputChain: 'polygon',
  recipient: '0x1111111111111111111111111111111111111111',
};

test('canonical JSON is deterministic regardless of key order', () => {
  const first = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  const second = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(first, second);
  assert.equal(first, '{"a":{"c":3,"d":2},"b":1}');
  const payloadA = buildIntentSigningPayload(intent);
  const payloadB = buildIntentSigningPayload({
    recipient: intent.recipient,
    outputChain: intent.outputChain,
    inputAmount: intent.inputAmount,
    inputAsset: intent.inputAsset,
    kind: intent.kind,
  });
  assert.equal(payloadA.message, payloadB.message);
  assert.equal(payloadA.hashHex, payloadB.hashHex);
});

test('SEP-53 sign and verify round trip succeeds', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signer = createEd25519Signer(privateKey);
  const signed = await signIntent(intent, signer);
  assert.equal(verifyIntentSignature(intent, signed.signatureHex, publicKey), true);
  assert.equal(verifyIntentSignature(intent, signed.signatureBase64, publicKey), true);
  const rawSignature = await signSep53Message(signed.message, signer);
  assert.equal(verifySep53Message(signed.message, rawSignature, publicKey), true);
});

test('tampered intent payload fails verification', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signed = await signIntent(intent, createEd25519Signer(privateKey));
  const tampered = { ...intent, inputAmount: 101 };
  assert.equal(verifyIntentSignature(tampered, signed.signatureHex, publicKey), false);
});

test('wrong public key fails verification', async () => {
  const signerKeys = generateKeyPairSync('ed25519');
  const otherKeys = generateKeyPairSync('ed25519');
  const signed = await signIntent(intent, createEd25519Signer(signerKeys.privateKey));
  assert.equal(verifyIntentSignature(intent, signed.signatureHex, otherKeys.publicKey), false);
});

test('verification accepts a Stellar account address', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const address = rawPublicKeyToStellarAddress(rawPublicKey);
  assert.match(address, /^G[A-Z2-7]{55}$/);
  const signed = await signIntent(intent, createEd25519Signer(privateKey));
  assert.equal(verifyIntentSignature(intent, signed.signatureHex, address), true);
});

test('signing without a signer is refused', async () => {
  await assert.rejects(signIntent(intent, null), /signer is required/);
});
