// Oruva Intents sandbox API keys (testnet MVP).
//
// Issues scoped API keys for testnet sandbox use. Only a SHA-256 hash
// of each key is stored, together with metadata: id, scopes, sandbox
// flag, label and created or revoked timestamps. The raw key is
// returned exactly once at issuance and is never stored or logged.
// Keys carry 256 bits of Node crypto randomness, so a plain SHA-256
// hash is safe to store; an optional pepper switches hashing to
// HMAC-SHA256 for deployments that want a server-side secret mixed in.

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

export const API_KEY_SCOPES = Object.freeze({
  QUOTE: 'intents:quote',
  SUBMIT: 'intents:submit',
  STATUS: 'intents:status',
  REFUND: 'intents:refund',
});

const WILDCARD_SCOPE = '*';

export function hashApiKey(rawKey, pepper = null) {
  if (typeof rawKey !== 'string' || rawKey === '') {
    throw new Error('rawKey is required');
  }
  if (pepper) {
    return createHmac('sha256', pepper).update(rawKey, 'utf8').digest('hex');
  }
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

function normalizeScopes(scopes) {
  if (scopes == null) return [];
  if (!Array.isArray(scopes)) throw new Error('scopes must be an array');
  const normalized = [];
  for (const scope of scopes) {
    if (typeof scope !== 'string' || scope.trim() === '') {
      throw new Error('each scope must be a non-empty string');
    }
    const value = scope.trim();
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

function publicRecord(record) {
  return {
    id: record.id,
    scopes: [...record.scopes],
    sandbox: record.sandbox,
    label: record.label,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt ?? null,
    revokedAt: record.revokedAt,
  };
}

export class ApiKeyStore {
  constructor({ now = () => new Date(), pepper = null } = {}) {
    this.now = now;
    this.pepper = pepper;
    this.records = new Map();
    this.byHash = new Map();
  }

  timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString();
  }

  issueKey({ scopes = [], sandbox = false, label = '', expiresAt = null } = {}) {
    const normalizedScopes = normalizeScopes(scopes);
    const isSandbox = Boolean(sandbox);
    const cleanLabel = typeof label === 'string' ? label : String(label ?? '');
    let cleanExpiresAt = null;
    if (expiresAt != null) {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime())) throw new Error('expiresAt must be a valid date');
      cleanExpiresAt = parsed.toISOString();
    }
    const prefix = isSandbox ? 'oruva_test' : 'oruva_live';
    let rawKey = '';
    let keyHash = '';
    do {
      rawKey = `${prefix}_${randomBytes(32).toString('base64url')}`;
      keyHash = hashApiKey(rawKey, this.pepper);
    } while (this.byHash.has(keyHash));
    const record = {
      id: `key-${randomUUID()}`,
      keyHash,
      scopes: normalizedScopes,
      sandbox: isSandbox,
      label: cleanLabel,
      createdAt: this.timestamp(),
      expiresAt: cleanExpiresAt,
      revokedAt: null,
    };
    this.records.set(record.id, record);
    this.byHash.set(keyHash, record.id);
    return { rawKey, record: publicRecord(record) };
  }

  verifyKey(rawKey, requiredScope = null, options = {}) {
    if (typeof rawKey !== 'string' || rawKey === '') {
      return { ok: false, reason: 'invalid_key' };
    }
    const keyHash = hashApiKey(rawKey, this.pepper);
    const id = this.byHash.get(keyHash);
    const record = id ? this.records.get(id) : null;
    if (!record) return { ok: false, reason: 'invalid_key' };
    if (record.revokedAt) return { ok: false, reason: 'revoked' };
    if (record.expiresAt && new Date(this.timestamp()) >= new Date(record.expiresAt)) {
      return { ok: false, reason: 'expired' };
    }
    const allowSandbox = Boolean(options.allowSandbox);
    const requireSandbox = Boolean(options.requireSandbox);
    if (requireSandbox && !record.sandbox) {
      return { ok: false, reason: 'sandbox_required' };
    }
    if (record.sandbox && !allowSandbox && !requireSandbox) {
      return { ok: false, reason: 'sandbox_not_allowed' };
    }
    if (requiredScope != null) {
      if (typeof requiredScope !== 'string' || requiredScope.trim() === '') {
        return { ok: false, reason: 'insufficient_scope' };
      }
      const granted = record.scopes.includes(requiredScope)
        || record.scopes.includes(WILDCARD_SCOPE);
      if (!granted) return { ok: false, reason: 'insufficient_scope' };
    }
    return {
      ok: true,
      keyId: record.id,
      scopes: [...record.scopes],
      sandbox: record.sandbox,
      label: record.label,
    };
  }

  assertKey(rawKey, requiredScope = null, options = {}) {
    const result = this.verifyKey(rawKey, requiredScope, options);
    if (!result.ok) {
      throw new Error(`api key verification failed: ${result.reason}`);
    }
    return result;
  }

  revokeKey(id) {
    const record = this.records.get(id);
    if (!record) throw new Error('api key not found');
    if (!record.revokedAt) record.revokedAt = this.timestamp();
    return publicRecord(record);
  }

  getKey(id) {
    const record = this.records.get(id);
    return record ? publicRecord(record) : null;
  }

  listKeys() {
    return [...this.records.values()].map(publicRecord);
  }
}

export function createApiKeyStore(options = {}) {
  return new ApiKeyStore(options);
}

// Convenience default store for simple wiring. Applications that need
// isolation, a pepper or a custom clock should create their own store
// with createApiKeyStore and use its methods.
const defaultStore = new ApiKeyStore();

export function issueKey(options = {}) {
  return defaultStore.issueKey(options);
}

export function verifyKey(rawKey, requiredScope = null, options = {}) {
  return defaultStore.verifyKey(rawKey, requiredScope, options);
}

export function revokeKey(id) {
  return defaultStore.revokeKey(id);
}

export function listKeys() {
  return defaultStore.listKeys();
}
