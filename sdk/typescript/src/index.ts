// Oruva Stellar Intents TypeScript SDK skeleton.
//
// Testnet and simulated routes only in this phase. The SDK talks to
// the public quote, submit, status and refund API contracts. It does
// not claim live fiat payout.

export type IntentKind =
  | 'fare_payment'
  | 'driver_payout'
  | 'automatic_convert'
  | 'manual_convert'
  | 'swap_convert'
  | 'cross_chain_payout'
  | 'escrow_release'
  | 'recurring_session'
  | 'agent_payment'
  | 'bulk_disbursement'
  | 'anchor_off_ramp'
  | 'anchor_on_ramp';

export interface QuoteRequest {
  kind: IntentKind;
  userId: string;
  inputAsset: string;
  inputAmount: number;
  outputAsset: string;
  outputChain: string;
  minOutputAmount: number;
  recipient: string;
  deadline: string;
  spendLimit?: number;
}

export interface QuoteResponse {
  quoteId: string;
  status: 'quoted' | 'no_route';
  bestBid: unknown;
  bids: unknown[];
}

export interface SubmitRequest {
  quoteId: string;
  idempotencyKey?: string;
}

export interface IntentRecord {
  intentId: string;
  status: string;
  txHashes?: string[];
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  idempotencyKeyFactory?: () => string;
}

export class OruvaApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`Oruva Stellar Intents API error ${status}`);
    this.name = 'OruvaApiError';
    this.status = status;
    this.body = body;
  }
}

function defaultIdempotencyKey(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class OruvaStellarIntentsClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchImpl: FetchLike;
  private idempotencyKeyFactory: () => string;

  constructor(options: ClientOptions) {
    if (!options.baseUrl) throw new Error('baseUrl is required');
    if (!options.apiKey) throw new Error('apiKey is required');
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.idempotencyKeyFactory = options.idempotencyKeyFactory ?? defaultIdempotencyKey;
  }

  async quote(request: QuoteRequest): Promise<QuoteResponse> {
    return this.request<QuoteResponse>('/v1/intents/quote', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async submit(request: SubmitRequest): Promise<IntentRecord> {
    const idempotencyKey = request.idempotencyKey ?? this.idempotencyKeyFactory();
    return this.request<IntentRecord>('/v1/intents/submit', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ quoteId: request.quoteId, idempotencyKey }),
    });
  }

  async status(intentId: string): Promise<IntentRecord> {
    return this.request<IntentRecord>(`/v1/intents/${encodeURIComponent(intentId)}`, {
      method: 'GET',
    });
  }

  async refund(intentId: string): Promise<IntentRecord> {
    return this.request<IntentRecord>(`/v1/intents/${encodeURIComponent(intentId)}/refund`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  private async request<T>(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        ...(init.headers ?? {}),
      },
      body: init.body,
    });
    const body = await response.json();
    if (!response.ok) throw new OruvaApiError(response.status, body);
    return body as T;
  }
}
