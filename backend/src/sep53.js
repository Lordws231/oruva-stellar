// SEP-53 message signing helpers for off-chain intent payloads.
//
// SEP-53 signs the SHA-256 hash of the prefix "Stellar Signed
// Message:\n" followed by the message bytes, using Ed25519. This
// module uses Node built-in crypto only and holds no keys. Signing
// goes through an injected signer so callers keep custody of secret
// material and tests run fully offline.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

export const SEP53_PREFIX = 'Stellar Signed Message:\n';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STELLAR_ACCOUNT_VERSION = 48;
const STELLAR_SECRET_VERSION = 144;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value, seen) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonical JSON does not allow non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('canonical JSON does not allow circular values');
    seen.add(value);
    const parts = value.map((item) => canonicalValue(item, seen));
    seen.delete(value);
    return `[${parts.join(',')}]`;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw new Error('canonical JSON does not allow circular values');
    seen.add(value);
    const parts = Object.keys(value).sort().map((key) => {
      return `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`;
    });
    seen.delete(value);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`canonical JSON does not allow values of type ${typeof value}`);
}

export function canonicalJson(value) {
  return canonicalValue(value, new Set());
}

export function buildIntentMessage(intent) {
  if (!isPlainObject(intent)) throw new Error('intent must be a plain object');
  return canonicalJson(intent);
}

function messageBytes(message) {
  if (typeof message === 'string') return Buffer.from(message, 'utf8');
  if (Buffer.isBuffer(message)) return message;
  if (message instanceof Uint8Array) return Buffer.from(message);
  throw new Error('message must be a string or byte array');
}

export function sep53Hash(message) {
  return createHash('sha256')
    .update(Buffer.from(SEP53_PREFIX, 'utf8'))
    .update(messageBytes(message))
    .digest();
}

export function buildIntentSigningPayload(intent) {
  const message = buildIntentMessage(intent);
  const hash = sep53Hash(message);
  return { message, hash, hashHex: hash.toString('hex') };
}

function crc16Xmodem(buffer) {
  let crc = 0;
  for (const byte of buffer) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/=+$/, '');
  if (clean.length % 8 !== 0) throw new Error('invalid Stellar address encoding');
  const bytes = [];
  for (let index = 0; index < clean.length; index += 8) {
    let bits = 0;
    let value = 0;
    for (let offset = 0; offset < 8; offset += 1) {
      const digit = BASE32_ALPHABET.indexOf(clean[index + offset]);
      if (digit < 0) throw new Error('invalid Stellar address encoding');
      value = (value << 5) | digit;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((value >>> bits) & 0xff);
      }
    }
  }
  return Buffer.from(bytes);
}

function base32Encode(buffer) {
  let output = '';
  let bits = 0;
  let value = 0;
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeStrKey(text) {
  const decoded = base32Decode(text);
  if (decoded.length < 3) throw new Error('invalid Stellar address encoding');
  const payload = decoded.subarray(0, decoded.length - 2);
  const checksum = decoded[decoded.length - 2] | (decoded[decoded.length - 1] << 8);
  if (crc16Xmodem(payload) !== checksum) {
    throw new Error('invalid Stellar address checksum');
  }
  return { version: payload[0], data: Buffer.from(payload.subarray(1)) };
}

function encodeStrKey(version, data) {
  const payload = Buffer.concat([Buffer.from([version]), data]);
  const checksum = crc16Xmodem(payload);
  const full = Buffer.concat([payload, Buffer.from([checksum & 0xff, (checksum >> 8) & 0xff])]);
  return base32Encode(full);
}

export function stellarAddressToRawPublicKey(address) {
  if (typeof address !== 'string' || address.trim() === '') {
    throw new Error('Stellar address is required');
  }
  const { version, data } = decodeStrKey(address.trim());
  if (version !== STELLAR_ACCOUNT_VERSION || data.length !== 32) {
    throw new Error('Stellar address must be an account public key');
  }
  return data;
}

export function rawPublicKeyToStellarAddress(rawPublicKey) {
  const raw = Buffer.isBuffer(rawPublicKey) ? rawPublicKey : Buffer.from(rawPublicKey ?? []);
  if (raw.length !== 32) throw new Error('raw public key must be 32 bytes');
  return encodeStrKey(STELLAR_ACCOUNT_VERSION, raw);
}

function stellarSecretToSeed(secret) {
  const { version, data } = decodeStrKey(secret.trim());
  if (version !== STELLAR_SECRET_VERSION || data.length !== 32) {
    throw new Error('Stellar secret must be a secret seed');
  }
  return data;
}

function rawToPublicKeyObject(raw) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function seedToPrivateKeyObject(seed) {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

function isKeyObject(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.export === 'function';
}

function normalizePublicKey(publicKey) {
  if (publicKey == null) throw new Error('publicKey is required');
  if (isKeyObject(publicKey)) return publicKey;
  if (Buffer.isBuffer(publicKey) || publicKey instanceof Uint8Array) {
    const bytes = Buffer.from(publicKey);
    if (bytes.length === 32) return rawToPublicKeyObject(bytes);
    return createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  }
  if (typeof publicKey === 'string') {
    const text = publicKey.trim();
    if (text.includes('BEGIN')) return createPublicKey(text);
    if (/^G[A-Z2-7]{55}$/.test(text)) {
      return rawToPublicKeyObject(stellarAddressToRawPublicKey(text));
    }
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(text)) {
      return rawToPublicKeyObject(Buffer.from(text.replace(/^0x/, ''), 'hex'));
    }
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length === 32) return rawToPublicKeyObject(decoded);
    if (decoded.length > 32) {
      return createPublicKey({ key: decoded, format: 'der', type: 'spki' });
    }
  }
  throw new Error('publicKey must be a Stellar address, raw key, hex, base64, PEM or KeyObject');
}

function normalizePrivateKey(privateKey) {
  if (privateKey == null) throw new Error('privateKey is required');
  if (isKeyObject(privateKey)) return privateKey;
  if (Buffer.isBuffer(privateKey) || privateKey instanceof Uint8Array) {
    const bytes = Buffer.from(privateKey);
    if (bytes.length === 32) return seedToPrivateKeyObject(bytes);
    return createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  }
  if (typeof privateKey === 'string') {
    const text = privateKey.trim();
    if (text.includes('BEGIN')) return createPrivateKey(text);
    if (/^S[A-Z2-7]{55}$/.test(text)) return seedToPrivateKeyObject(stellarSecretToSeed(text));
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(text)) {
      return seedToPrivateKeyObject(Buffer.from(text.replace(/^0x/, ''), 'hex'));
    }
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length === 32) return seedToPrivateKeyObject(decoded);
    if (decoded.length > 32) {
      return createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' });
    }
  }
  throw new Error('privateKey must be a Stellar secret, raw seed, hex, base64, PEM or KeyObject');
}

export function createEd25519Signer(privateKey) {
  const keyObject = normalizePrivateKey(privateKey);
  return async (hash) => cryptoSign(null, Buffer.from(hash), keyObject);
}

function normalizeSignature(signature) {
  if (signature == null) throw new Error('signature is required');
  let bytes = null;
  if (Buffer.isBuffer(signature) || signature instanceof Uint8Array) {
    bytes = Buffer.from(signature);
  } else if (typeof signature === 'string') {
    const text = signature.trim();
    if (/^(0x)?[0-9a-fA-F]{128}$/.test(text)) {
      bytes = Buffer.from(text.replace(/^0x/, ''), 'hex');
    } else {
      bytes = Buffer.from(text, 'base64');
    }
  }
  if (!bytes || bytes.length !== 64) {
    throw new Error('signature must be 64 bytes');
  }
  return bytes;
}

async function signHash(hash, signer) {
  if (signer == null) throw new Error('signer is required');
  let result;
  if (isKeyObject(signer)) {
    result = cryptoSign(null, hash, signer);
  } else if (typeof signer === 'function') {
    result = await signer(hash);
  } else if (typeof signer.sign === 'function') {
    result = await signer.sign(hash);
  } else {
    throw new Error('signer must be a function, an object with sign, or a private KeyObject');
  }
  if (result && typeof result === 'object' && !Buffer.isBuffer(result) && !(result instanceof Uint8Array)) {
    result = result.signature;
  }
  return normalizeSignature(result);
}

export async function signSep53Message(message, signer) {
  return signHash(sep53Hash(message), signer);
}

export async function signIntent(intent, signer) {
  const payload = buildIntentSigningPayload(intent);
  const signature = await signHash(payload.hash, signer);
  return {
    message: payload.message,
    hashHex: payload.hashHex,
    signatureHex: signature.toString('hex'),
    signatureBase64: signature.toString('base64'),
  };
}

export function verifySep53Message(message, signature, publicKey) {
  const keyObject = normalizePublicKey(publicKey);
  const signatureBytes = normalizeSignature(signature);
  return cryptoVerify(null, sep53Hash(message), keyObject, signatureBytes);
}

export function verifyIntentSignature(intent, signature, publicKey) {
  return verifySep53Message(buildIntentMessage(intent), signature, publicKey);
}
