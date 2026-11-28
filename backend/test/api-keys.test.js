import assert from 'node:assert/strict';
import test from 'node:test';
import {
  API_KEY_SCOPES,
  ApiKeyStore,
  hashApiKey,
  issueKey,
  listKeys,
  revokeKey,
  verifyKey,
} from '../src/apiKeys.js';

const fixedNow = () => new Date('2026-11-28T12:00:00.000Z');

test('issuance returns the raw key once and stores only its hash', () => {
  const store = new ApiKeyStore({ now: fixedNow });
  const issued = store.issueKey({
    scopes: [API_KEY_SCOPES.QUOTE, API_KEY_SCOPES.STATUS],
    sandbox: true,
    label: 'dev sandbox',
  });
  assert.equal(typeof issued.rawKey, 'string');
  assert.equal(issued.rawKey.startsWith('oruva_test_'), true);
  assert.equal(issued.record.sandbox, true);
  assert.equal(issued.record.label, 'dev sandbox');
  assert.deepEqual(issued.record.scopes, ['intents:quote', 'intents:status']);
  assert.equal(issued.record.createdAt, '2026-11-28T12:00:00.000Z');
  assert.equal(issued.record.revokedAt, null);
  assert.equal('keyHash' in issued.record, false);
  assert.equal('rawKey' in issued.record, false);
  assert.equal(JSON.stringify(issued.record).includes(issued.rawKey), false);

  const stored = store.records.get(issued.record.id);
  assert.equal(stored.keyHash, hashApiKey(issued.rawKey));
  assert.notEqual(stored.keyHash, issued.rawKey);
  assert.equal(JSON.stringify(stored).includes(issued.rawKey), false);

  const listed = store.listKeys();
  assert.equal(listed.length, 1);
  assert.equal('keyHash' in listed[0], false);
  assert.equal(JSON.stringify(listed).includes(issued.rawKey), false);
  assert.equal(JSON.stringify(listed).includes(stored.keyHash), false);

  const second = store.issueKey({ scopes: [API_KEY_SCOPES.QUOTE], sandbox: true });
  assert.notEqual(second.rawKey, issued.rawKey);
  assert.notEqual(second.record.id, issued.record.id);
});

test('verify succeeds with the correct scope', () => {
  const store = new ApiKeyStore({ now: fixedNow });
  const { rawKey, record } = store.issueKey({
    scopes: [API_KEY_SCOPES.QUOTE, API_KEY_SCOPES.STATUS],
    sandbox: false,
    label: 'live dev',
  });
  assert.equal(rawKey.startsWith('oruva_live_'), true);
  const result = store.verifyKey(rawKey, API_KEY_SCOPES.QUOTE);
  assert.equal(result.ok, true);
  assert.equal(result.keyId, record.id);
  assert.equal(result.sandbox, false);
  assert.equal(store.verifyKey(rawKey).ok, true);
  assert.equal(store.assertKey(rawKey, API_KEY_SCOPES.STATUS).ok, true);
});

test('verify fails for a wrong scope and for an unknown key', () => {
  const store = new ApiKeyStore({ now: fixedNow });
  const { rawKey } = store.issueKey({ scopes: [API_KEY_SCOPES.QUOTE] });
  const wrongScope = store.verifyKey(rawKey, API_KEY_SCOPES.REFUND);
  assert.equal(wrongScope.ok, false);
  assert.equal(wrongScope.reason, 'insufficient_scope');
  const unknown = store.verifyKey('oruva_live_not-a-real-key', API_KEY_SCOPES.QUOTE);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'invalid_key');
  assert.equal(store.verifyKey('').ok, false);
  assert.throws(
    () => store.assertKey(rawKey, API_KEY_SCOPES.REFUND),
    /insufficient_scope/,
  );
});

test('a revoked key fails verification', () => {
  const store = new ApiKeyStore({ now: fixedNow });
  const { rawKey, record } = store.issueKey({ scopes: [API_KEY_SCOPES.QUOTE] });
  assert.equal(store.verifyKey(rawKey, API_KEY_SCOPES.QUOTE).ok, true);
  const revoked = store.revokeKey(record.id);
  assert.equal(revoked.revokedAt, '2026-11-28T12:00:00.000Z');
  const result = store.verifyKey(rawKey, API_KEY_SCOPES.QUOTE);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'revoked');
  assert.equal(store.listKeys()[0].revokedAt, '2026-11-28T12:00:00.000Z');
  assert.equal(store.revokeKey(record.id).revokedAt, '2026-11-28T12:00:00.000Z');
  assert.throws(() => store.revokeKey('key-missing'), /not found/);
});

test('a sandbox key is rejected unless sandbox use is allowed', () => {
  const store = new ApiKeyStore({ now: fixedNow });
  const sandbox = store.issueKey({ scopes: [API_KEY_SCOPES.QUOTE], sandbox: true });
  const rejected = store.verifyKey(sandbox.rawKey, API_KEY_SCOPES.QUOTE);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'sandbox_not_allowed');
  const allowed = store.verifyKey(sandbox.rawKey, API_KEY_SCOPES.QUOTE, { allowSandbox: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.sandbox, true);
  const sandboxOnly = store.verifyKey(sandbox.rawKey, API_KEY_SCOPES.QUOTE, { requireSandbox: true });
  assert.equal(sandboxOnly.ok, true);

  const live = store.issueKey({ scopes: [API_KEY_SCOPES.QUOTE], sandbox: false });
  const liveRejected = store.verifyKey(live.rawKey, API_KEY_SCOPES.QUOTE, { requireSandbox: true });
  assert.equal(liveRejected.ok, false);
  assert.equal(liveRejected.reason, 'sandbox_required');
});

test('module level helpers issue, verify, list and revoke', () => {
  const issued = issueKey({ scopes: [API_KEY_SCOPES.STATUS], sandbox: true, label: 'module test' });
  assert.equal(verifyKey(issued.rawKey, API_KEY_SCOPES.STATUS, { allowSandbox: true }).ok, true);
  assert.equal(listKeys().some((key) => key.id === issued.record.id), true);
  revokeKey(issued.record.id);
  assert.equal(verifyKey(issued.rawKey, API_KEY_SCOPES.STATUS, { allowSandbox: true }).ok, false);
});

test('issuance validates scopes', () => {
  const store = new ApiKeyStore({ now: fixedNow });
  assert.throws(() => store.issueKey({ scopes: 'intents:quote' }), /scopes must be an array/);
  assert.throws(() => store.issueKey({ scopes: [''] }), /non-empty string/);
  const deduped = store.issueKey({ scopes: ['intents:quote', 'intents:quote'] });
  assert.deepEqual(deduped.record.scopes, ['intents:quote']);
});
