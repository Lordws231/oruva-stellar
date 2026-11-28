// Cross-chain delivery proof verification.
//
// Settlement evidence for cross-chain fills must prove delivery, not
// only repeat a solver claim. CCTP proofs bind the Circle message
// and attestation format to mint evidence for the intent. NEAR
// 1Click proofs check delivery status through an injected transport
// before any solver delivery reference is trusted. All checks run
// offline against fixtures or injected transports. Attestation
// handling here covers presence, format and field binding; full
// attester signature recovery needs Circle attester keys and stays
// outside this offline layer.

import { CCTP_POLYGON_DOMAIN, CCTP_STELLAR_DOMAIN } from './cctpBridge.js';

const NEAR_SUCCESS_STATUSES = new Set(['success', 'successful', 'completed', 'complete']);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function parseAmount(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return amount;
}

function amountsMatch(first, second) {
  return Math.abs(Number(first) - Number(second)) <= 1e-6;
}

function normalizeRecipient(value) {
  const text = requireText(value, 'recipient');
  const lower = text.toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(lower)) return lower;
  if (/^0x[0-9a-f]{64}$/.test(lower)) return `0x${lower.slice(-40)}`;
  return text;
}

function recipientsMatch(expected, actual) {
  return normalizeRecipient(expected) === normalizeRecipient(actual);
}

function requireIntent(intent) {
  if (!intent || typeof intent !== 'object') throw new Error('intent is required');
  requireText(intent.recipient, 'intent.recipient');
  parseAmount(intent.minOutputAmount, 'intent.minOutputAmount');
  return intent;
}

function requireEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') throw new Error('delivery evidence is required');
  return evidence;
}

function hexToBuffer(hex, field) {
  if (typeof hex !== 'string') throw new Error(`${field} must be a hex string`);
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean === '' || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`${field} must be a hex string`);
  }
  return Buffer.from(clean, 'hex');
}

function readUint32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function readUint64Decimal(buffer, offset) {
  return buffer.readBigUInt64BE(offset).toString();
}

function readBytes32Hex(buffer, offset) {
  return `0x${buffer.subarray(offset, offset + 32).toString('hex')}`;
}

function readUint256Decimal(buffer, offset) {
  let value = 0n;
  for (let index = 0; index < 32; index += 1) {
    value = (value << 8n) | BigInt(buffer[offset + index]);
  }
  return value;
}

function parseCctpMessageBytes(buffer) {
  if (buffer.length < 116) throw new Error('CCTP message is too short');
  const bodyOffset = 116;
  if (buffer.length < bodyOffset + 132) {
    throw new Error('CCTP burn message body is too short');
  }
  const amountMicro = readUint256Decimal(buffer, bodyOffset + 68);
  return {
    version: readUint32(buffer, 0),
    sourceDomain: readUint32(buffer, 4),
    destinationDomain: readUint32(buffer, 8),
    nonce: readUint64Decimal(buffer, 12),
    sender: readBytes32Hex(buffer, 20),
    recipient: readBytes32Hex(buffer, 52),
    mintRecipient: readBytes32Hex(buffer, bodyOffset + 36),
    amount: Number(amountMicro) / 1_000_000,
    amountMicro: amountMicro.toString(),
    messageSender: readBytes32Hex(buffer, bodyOffset + 100),
  };
}

function normalizeNonce(value) {
  if (value == null || String(value).trim() === '') throw new Error('CCTP nonce is required');
  const text = String(value).trim();
  if (/^[0-9]+$/.test(text)) return text;
  if (/^(0x)?[0-9a-fA-F]+$/.test(text)) return text;
  throw new Error('CCTP nonce is invalid');
}

function normalizeDomain(value, field) {
  const domain = Number(value);
  if (!Number.isSafeInteger(domain) || domain < 0) {
    throw new Error(`${field} must be a non-negative integer domain`);
  }
  return domain;
}

function parseCctpMessageObject(message) {
  const amount = message.amount ?? message.amountUsdc ?? message.burnAmount;
  return {
    version: message.version ?? null,
    sourceDomain: normalizeDomain(message.sourceDomain ?? message.source_domain, 'sourceDomain'),
    destinationDomain: normalizeDomain(
      message.destinationDomain ?? message.destination_domain,
      'destinationDomain',
    ),
    nonce: normalizeNonce(message.nonce),
    sender: requireText(message.sender ?? message.messageSender ?? message.burnSender, 'sender'),
    recipient: message.recipient ?? null,
    mintRecipient: requireText(message.mintRecipient ?? message.recipient, 'mintRecipient'),
    amount: parseAmount(amount, 'amount'),
    amountMicro: message.amountMicro ?? null,
    messageSender: message.messageSender ?? message.sender ?? null,
  };
}

export function parseCctpMessage(input) {
  if (typeof input === 'string') return parseCctpMessageBytes(hexToBuffer(input, 'message'));
  if (!input || typeof input !== 'object') throw new Error('CCTP message is required');
  const hex = input.messageHex ?? input.messageBytes ?? input.message;
  if (typeof hex === 'string' && /^(0x)?[0-9a-fA-F]+$/.test(hex.trim()) && hex.trim().length > 100) {
    return parseCctpMessageBytes(hexToBuffer(hex, 'message'));
  }
  return parseCctpMessageObject(input);
}

function validateAttestation(attestation, attestationStatus) {
  if (attestationStatus != null && String(attestationStatus).trim() !== '') {
    if (String(attestationStatus).trim().toLowerCase() !== 'complete') {
      throw new Error('CCTP attestation is not complete');
    }
  }
  let value = attestation;
  if (value && typeof value === 'object') {
    if (value.status != null && String(value.status).trim().toLowerCase() !== 'complete') {
      throw new Error('CCTP attestation is not complete');
    }
    value = value.attestation ?? value.signature ?? value.signatures;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('CCTP attestation is required');
  }
  const bytes = hexToBuffer(value, 'attestation');
  if (bytes.length < 65 || bytes.length % 65 !== 0) {
    throw new Error('CCTP attestation format is invalid');
  }
  for (let offset = 0; offset < bytes.length; offset += 65) {
    const recovery = bytes[offset + 64];
    if (![0, 1, 27, 28].includes(recovery)) {
      throw new Error('CCTP attestation format is invalid');
    }
  }
  return `0x${bytes.toString('hex')}`;
}

export function verifyCctpDeliveryProof({
  intent,
  evidence,
  expectedSourceDomain = CCTP_STELLAR_DOMAIN,
  expectedDestinationDomain = CCTP_POLYGON_DOMAIN,
  expectedSender = null,
  expectedAmount = null,
} = {}) {
  requireIntent(intent);
  requireEvidence(evidence);
  const messageInput = evidence.message ?? evidence.cctpMessage ?? evidence;
  const message = parseCctpMessage(messageInput);
  if (message.sourceDomain !== expectedSourceDomain) {
    throw new Error('CCTP source domain mismatch');
  }
  if (message.destinationDomain !== expectedDestinationDomain) {
    throw new Error('CCTP destination domain mismatch');
  }
  const burner = message.messageSender ?? message.sender;
  requireText(burner, 'sender');
  if (normalizeRecipient(burner) === ZERO_ADDRESS) {
    throw new Error('CCTP sender must not be the zero address');
  }
  const senderExpectation = expectedSender ?? evidence.expectedSender ?? null;
  if (senderExpectation != null && !recipientsMatch(senderExpectation, burner)) {
    throw new Error('CCTP sender mismatch');
  }
  if (!recipientsMatch(intent.recipient, message.mintRecipient)) {
    throw new Error('CCTP recipient mismatch');
  }
  validateAttestation(
    evidence.attestation ?? evidence.circleAttestation,
    evidence.attestationStatus,
  );
  const mint = evidence.mint ?? evidence.mintEvidence ?? evidence;
  const mintTxHash = mint.txHash ?? mint.mintTxHash ?? mint.mintHash ?? mint.forwardTxHash
    ?? evidence.mintTxHash ?? evidence.mintHash ?? evidence.forwardTxHash ?? evidence.txHash;
  requireText(mintTxHash, 'mintTxHash');
  const mintAmountRaw = mint.amount ?? mint.amountUsdc ?? evidence.mintAmount;
  if (mintAmountRaw == null) throw new Error('mint amount is required');
  const mintAmount = parseAmount(mintAmountRaw, 'mint amount');
  const mintRecipientRaw = mint.recipient ?? mint.mintRecipient ?? evidence.mintRecipient;
  if (mintRecipientRaw == null) throw new Error('mint recipient is required');
  if (!amountsMatch(message.amount, mintAmount)) {
    throw new Error('CCTP amount mismatch');
  }
  if (!recipientsMatch(intent.recipient, mintRecipientRaw)
    || !recipientsMatch(message.mintRecipient, mintRecipientRaw)) {
    throw new Error('CCTP recipient mismatch');
  }
  if (mintAmount < Number(intent.minOutputAmount)) {
    throw new Error('CCTP amount below minimum output');
  }
  if (expectedAmount != null && !amountsMatch(expectedAmount, mintAmount)) {
    throw new Error('CCTP amount mismatch');
  }
  return {
    verified: true,
    route: 'cctp_stellar_to_polygon',
    sourceDomain: message.sourceDomain,
    destinationDomain: message.destinationDomain,
    nonce: message.nonce,
    sender: burner,
    recipient: intent.recipient,
    amount: mintAmount,
    mintTxHash: requireText(mintTxHash, 'mintTxHash'),
    burnTxHash: evidence.burnTxHash ?? evidence.burnHash ?? null,
  };
}

function resolveNearStatusMethod(transport) {
  if (!transport || typeof transport !== 'object') return null;
  if (typeof transport.getDeliveryStatus === 'function') return transport.getDeliveryStatus.bind(transport);
  if (typeof transport.deliveryStatus === 'function') return transport.deliveryStatus.bind(transport);
  if (typeof transport.getStatus === 'function') return transport.getStatus.bind(transport);
  if (typeof transport.status === 'function') return transport.status.bind(transport);
  return null;
}

export async function verifyNearDeliveryProof({ intent, selectedBid = null, evidence, transport } = {}) {
  requireIntent(intent);
  requireEvidence(evidence);
  const statusMethod = resolveNearStatusMethod(transport);
  if (!statusMethod) throw new Error('NEAR delivery transport is required');
  const quoteId = evidence.quoteId ?? evidence.nearQuoteId ?? selectedBid?.evidence?.quoteId ?? null;
  const depositAddress = evidence.depositAddress ?? selectedBid?.evidence?.depositAddress ?? null;
  if (!quoteId && !depositAddress) {
    throw new Error('NEAR quote reference is required');
  }
  const solverDeliveryTx = evidence.solverDeliveryTx ?? evidence.deliveryTxHash ?? evidence.txHash ?? null;
  const result = await statusMethod({
    quoteId,
    depositAddress,
    solverDeliveryTx,
    recipient: intent.recipient,
    outputChain: intent.outputChain,
    outputAsset: intent.outputAsset,
  });
  if (!result || typeof result !== 'object') {
    throw new Error('NEAR delivery status not found');
  }
  const rawStatus = result.status ?? result.state ?? result.deliveryStatus ?? result.delivery_state;
  if (rawStatus == null || String(rawStatus).trim() === '') {
    throw new Error('NEAR delivery status is required');
  }
  const status = String(rawStatus).trim().toLowerCase();
  if (!NEAR_SUCCESS_STATUSES.has(status)) {
    throw new Error(`NEAR delivery is not complete: ${String(rawStatus).trim()}`);
  }
  const deliveredRaw = result.deliveredAmount ?? result.outputAmount ?? result.amount ?? result.delivered_amount;
  if (deliveredRaw == null) throw new Error('NEAR delivered amount is required');
  const deliveredAmount = parseAmount(deliveredRaw, 'NEAR delivered amount');
  const claimedRaw = evidence.deliveredAmount ?? evidence.outputAmount ?? evidence.amount ?? null;
  if (claimedRaw != null && !amountsMatch(claimedRaw, deliveredAmount)) {
    throw new Error('NEAR delivered amount mismatch');
  }
  if (deliveredAmount < Number(intent.minOutputAmount)) {
    throw new Error('NEAR delivered amount below minimum output');
  }
  const deliveredRecipient = result.recipient ?? result.destinationRecipient ?? result.recipientAddress;
  if (deliveredRecipient == null) throw new Error('NEAR delivered recipient is required');
  if (!recipientsMatch(intent.recipient, deliveredRecipient)) {
    throw new Error('NEAR recipient mismatch');
  }
  if (result.quoteId != null && quoteId != null && String(result.quoteId) !== String(quoteId)) {
    throw new Error('NEAR quote mismatch');
  }
  if (result.depositAddress != null && depositAddress != null
    && String(result.depositAddress) !== String(depositAddress)) {
    throw new Error('NEAR quote mismatch');
  }
  const deliveryTxHash = result.deliveryTxHash ?? result.solverDeliveryTx ?? result.txHash ?? solverDeliveryTx;
  requireText(deliveryTxHash, 'NEAR delivery transaction hash');
  return {
    verified: true,
    route: 'near_intents_1click',
    status: String(rawStatus).trim(),
    amount: deliveredAmount,
    recipient: intent.recipient,
    quoteId: quoteId ?? result.quoteId ?? null,
    deliveryTxHash: requireText(deliveryTxHash, 'NEAR delivery transaction hash'),
  };
}

export async function verifyDeliveryProof({
  intent,
  selectedBid = null,
  evidence,
  transports = {},
  cctpTransport = null,
  nearTransport = null,
  expectedSourceDomain,
  expectedDestinationDomain,
  expectedSender = null,
  expectedAmount = null,
} = {}) {
  requireIntent(intent);
  requireEvidence(evidence);
  void cctpTransport;
  const route = evidence.route ?? selectedBid?.route ?? null;
  if (route === 'cctp_stellar_to_polygon') {
    return verifyCctpDeliveryProof({
      intent,
      evidence,
      expectedSourceDomain,
      expectedDestinationDomain,
      expectedSender,
      expectedAmount,
    });
  }
  if (route === 'near_intents_1click') {
    return verifyNearDeliveryProof({
      intent,
      selectedBid,
      evidence,
      transport: nearTransport ?? transports.near ?? transports.nearOneClick ?? null,
    });
  }
  if (route == null && intent.outputChain === 'polygon' && intent.inputAsset === 'USDC') {
    return verifyCctpDeliveryProof({
      intent,
      evidence,
      expectedSourceDomain,
      expectedDestinationDomain,
      expectedSender,
      expectedAmount,
    });
  }
  if (route == null && intent.outputChain !== 'stellar') {
    return verifyNearDeliveryProof({
      intent,
      selectedBid,
      evidence,
      transport: nearTransport ?? transports.near ?? transports.nearOneClick ?? null,
    });
  }
  throw new Error('unsupported delivery proof route');
}
