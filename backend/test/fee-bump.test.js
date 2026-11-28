import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FeeBumpSponsor,
  buildFeeBumpRequest,
  createFeeBumpEnvelope,
} from '../src/feeBump.js';

const sponsor = 'GSPONSORACCOUNTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function fakeSigner() {
  return {
    calls: [],
    async signFeeBump(request) {
      this.calls.push(request);
      return { envelopeXdr: 'fee-bump-envelope-xdr', signature: 'sponsor-signature' };
    },
  };
}

test('fee-bump within cap succeeds through the injected signer', async () => {
  const signer = fakeSigner();
  const builder = new FeeBumpSponsor({ signer });
  const envelope = await builder.build({
    innerTx: { xdr: 'inner-envelope-xdr', fee: 100, sourceAccount: 'GINNER' },
    sponsor,
    fee: 200,
    maxFee: 500,
  });
  assert.equal(envelope.type, 'fee_bump');
  assert.equal(envelope.sponsor, sponsor);
  assert.equal(envelope.fee, 200);
  assert.equal(envelope.inner.xdr, 'inner-envelope-xdr');
  assert.equal(envelope.envelopeXdr, 'fee-bump-envelope-xdr');
  assert.equal(signer.calls.length, 1);
  assert.equal(signer.calls[0].fee, 200);
});

test('fee-bump accepts a bare inner XDR string', async () => {
  const envelope = await createFeeBumpEnvelope({
    signer: async () => 'fee-bump-envelope-xdr',
    innerTx: 'inner-envelope-xdr',
    sponsor,
    fee: '200',
    maxFee: '500',
  });
  assert.equal(envelope.inner.xdr, 'inner-envelope-xdr');
  assert.equal(envelope.inner.fee, null);
  assert.equal(envelope.envelopeXdr, 'fee-bump-envelope-xdr');
});

test('fee-bump over the cap is refused before signing', async () => {
  const signer = fakeSigner();
  const builder = new FeeBumpSponsor({ signer });
  await assert.rejects(
    builder.build({ innerTx: 'inner-envelope-xdr', sponsor, fee: 501, maxFee: 500 }),
    /fee exceeds maxFee cap/,
  );
  assert.equal(signer.calls.length, 0);
  assert.throws(
    () => buildFeeBumpRequest({ innerTx: 'inner-envelope-xdr', sponsor, fee: 501, maxFee: 500 }),
    /fee exceeds maxFee cap/,
  );
});

test('fee-bump without a sponsor is refused', async () => {
  const builder = new FeeBumpSponsor({ signer: fakeSigner() });
  await assert.rejects(
    builder.build({ innerTx: 'inner-envelope-xdr', sponsor: '', fee: 200, maxFee: 500 }),
    /sponsor is required/,
  );
  await assert.rejects(
    builder.build({ innerTx: 'inner-envelope-xdr', fee: 200, maxFee: 500 }),
    /sponsor is required/,
  );
});

test('fee-bump below the inner fee is refused', async () => {
  const builder = new FeeBumpSponsor({ signer: fakeSigner() });
  await assert.rejects(
    builder.build({
      innerTx: { xdr: 'inner-envelope-xdr', fee: 300 },
      sponsor,
      fee: 200,
      maxFee: 500,
    }),
    /at least the inner transaction fee/,
  );
});
