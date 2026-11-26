export async function createStellarKeypairFactory() {
  const sdk = await import('@stellar/stellar-sdk');
  return () => {
    const keypair = sdk.Keypair.random();
    return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
  };
}

export class HorizonPaymentsClient {
  constructor(horizonUrl = 'https://horizon-testnet.stellar.org') {
    this.horizonUrl = horizonUrl.replace(/\/$/, '');
  }

  async paymentsForAccount(publicKey) {
    const url = `${this.horizonUrl}/accounts/${publicKey}/payments?order=desc&limit=50`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Horizon payments request failed: ${response.status}`);
    const body = await response.json();
    return (body._embedded?.records ?? [])
      .filter((record) => ['payment', 'path_payment_strict_send', 'path_payment_strict_receive'].includes(record.type))
      .filter((record) => record.to === publicKey)
      .map((record) => ({
        id: record.id,
        txHash: record.transaction_hash,
        from: record.from,
        to: record.to,
        amount: record.amount,
        asset: {
          code: record.asset_code ?? 'XLM',
          issuer: record.asset_issuer ?? null,
        },
      }));
  }
}

export class HorizonPathRateProvider {
  constructor(horizonUrl = 'https://horizon-testnet.stellar.org', usdcIssuer) {
    this.horizonUrl = horizonUrl.replace(/\/$/, '');
    this.usdcIssuer = usdcIssuer;
  }

  async rate({ fromAsset, toAsset }) {
    if (fromAsset === toAsset) return 1;
    if (toAsset === 'NGN') {
      throw new Error('NGN conversion requires an anchor or payout partner quote');
    }
    const source = this.#assetParam(fromAsset);
    const destination = this.#assetParam(toAsset);
    const url = `${this.horizonUrl}/paths/strict-send?source_asset_type=${source.type}` +
      `${source.code ? `&source_asset_code=${source.code}&source_asset_issuer=${source.issuer}` : ''}` +
      `&source_amount=1&destination_assets=${destination.param}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Horizon path request failed: ${response.status}`);
    const body = await response.json();
    const record = body._embedded?.records?.[0];
    if (!record) throw new Error('no Stellar path found for conversion');
    return Number(record.destination_amount);
  }

  #assetParam(asset) {
    if (asset === 'XLM') return { type: 'native', param: 'native' };
    if (asset === 'USDC') {
      if (!this.usdcIssuer) throw new Error('USDC issuer is required');
      return { type: 'credit_alphanum4', code: 'USDC', issuer: this.usdcIssuer, param: `USDC:${this.usdcIssuer}` };
    }
    throw new Error(`unsupported Stellar asset ${asset}`);
  }
}
