// Oruva Intents swap API (testnet sandbox model).
//
// The hosted swap layer over the verifier ledger and solver relay:
// token catalog, dry and committed quotes with swap types and fee
// breakdowns, deposit-address flow with memo, status lifecycle,
// signed-intent execution for ledger balances, and limit orders.
// Settlement here is testnet-simulated through the ledger; no real
// funds move and every record says so.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { VerifierLedger, VERIFYING_CONTRACT } from './ledger.js';
import { SolverRelay } from './relay.js';
import { canonicalJson, verifyIntentSignature } from './sep53.js';

export const SWAP_STATUSES = Object.freeze([
  'PENDING_DEPOSIT',
  'KNOWN_DEPOSIT_TX',
  'PROCESSING',
  'SUCCESS',
  'INCOMPLETE_DEPOSIT',
  'REFUNDED',
  'FAILED',
]);

export const ORDER_STATUSES = Object.freeze([
  'AWAITING_DEPOSIT',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'PENDING_CANCEL',
  'CANCELED',
  'EXPIRED',
  'UNTRIGGERED',
]);

export const CHAINS = Object.freeze({
  stellar: { family: 'stellar', nativeSymbol: 'XLM', nativeDecimals: 7, defaultDecimals: 7, cctp: true },
  ethereum: { family: 'evm', nativeSymbol: 'ETH', nativeDecimals: 18, defaultDecimals: 18, cctp: true },
  arbitrum: { family: 'evm', nativeSymbol: 'ETH', nativeDecimals: 18, defaultDecimals: 18, cctp: true },
  base: { family: 'evm', nativeSymbol: 'ETH', nativeDecimals: 18, defaultDecimals: 18, cctp: true },
  optimism: { family: 'evm', nativeSymbol: 'ETH', nativeDecimals: 18, defaultDecimals: 18, cctp: true },
  polygon: { family: 'evm', nativeSymbol: 'POL', nativeDecimals: 18, defaultDecimals: 18, cctp: true },
  bnb: { family: 'evm', nativeSymbol: 'BNB', nativeDecimals: 18, defaultDecimals: 18, cctp: false },
  avalanche: { family: 'evm', nativeSymbol: 'AVAX', nativeDecimals: 18, defaultDecimals: 18, cctp: true },
  bitcoin: { family: 'bitcoin', nativeSymbol: 'BTC', nativeDecimals: 8, defaultDecimals: 8, cctp: false },
  litecoin: { family: 'bitcoin', nativeSymbol: 'LTC', nativeDecimals: 8, defaultDecimals: 8, cctp: false },
  dogecoin: { family: 'bitcoin', nativeSymbol: 'DOGE', nativeDecimals: 8, defaultDecimals: 8, cctp: false },
  'bitcoin-cash': { family: 'bitcoin', nativeSymbol: 'BCH', nativeDecimals: 8, defaultDecimals: 8, cctp: false },
  zcash: { family: 'bitcoin', nativeSymbol: 'ZEC', nativeDecimals: 8, defaultDecimals: 8, cctp: false },
  solana: { family: 'solana', nativeSymbol: 'SOL', nativeDecimals: 9, defaultDecimals: 9, cctp: true },
  near: { family: 'near', nativeSymbol: 'NEAR', nativeDecimals: 24, defaultDecimals: 24, cctp: false },
  xrp: { family: 'xrp', nativeSymbol: 'XRP', nativeDecimals: 6, defaultDecimals: 6, cctp: false },
  tron: { family: 'tron', nativeSymbol: 'TRX', nativeDecimals: 6, defaultDecimals: 6, cctp: false },
  ton: { family: 'ton', nativeSymbol: 'TON', nativeDecimals: 9, defaultDecimals: 9, cctp: false },
});

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'RLUSD', 'EURC']);

function catalogEntry(chain, symbol, decimals, issuer = null) {
  return {
    assetId: issuer ? `${chain}:${symbol}:${issuer}` : `${chain}:${symbol}`,
    symbol,
    chain: `${chain}-testnet`,
    chainId: chain,
    decimals,
  };
}

export const TOKEN_CATALOG = Object.freeze([
  catalogEntry('stellar', 'XLM', 7),
  catalogEntry('stellar', 'USDC', 7, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'),
  catalogEntry('ethereum', 'ETH', 18),
  catalogEntry('ethereum', 'USDC', 6),
  catalogEntry('ethereum', 'USDT', 6),
  catalogEntry('ethereum', 'DAI', 18),
  catalogEntry('ethereum', 'WBTC', 8),
  catalogEntry('arbitrum', 'ETH', 18),
  catalogEntry('arbitrum', 'USDC', 6),
  catalogEntry('arbitrum', 'USDT', 6),
  catalogEntry('base', 'ETH', 18),
  catalogEntry('base', 'USDC', 6),
  catalogEntry('optimism', 'ETH', 18),
  catalogEntry('optimism', 'USDC', 6),
  catalogEntry('polygon', 'POL', 18),
  catalogEntry('polygon', 'USDC', 6),
  catalogEntry('polygon', 'USDT', 6),
  catalogEntry('bnb', 'BNB', 18),
  catalogEntry('bnb', 'USDT', 18),
  catalogEntry('bnb', 'USDC', 18),
  catalogEntry('avalanche', 'AVAX', 18),
  catalogEntry('avalanche', 'USDC', 6),
  catalogEntry('bitcoin', 'BTC', 8),
  catalogEntry('litecoin', 'LTC', 8),
  catalogEntry('dogecoin', 'DOGE', 8),
  catalogEntry('bitcoin-cash', 'BCH', 8),
  catalogEntry('zcash', 'ZEC', 8),
  catalogEntry('solana', 'SOL', 9),
  catalogEntry('solana', 'USDC', 6),
  catalogEntry('solana', 'USDT', 6),
  catalogEntry('near', 'NEAR', 24),
  catalogEntry('near', 'USDC', 6),
  catalogEntry('xrp', 'XRP', 6),
  catalogEntry('xrp', 'RLUSD', 6),
  catalogEntry('tron', 'TRX', 6),
  catalogEntry('tron', 'USDT', 6),
  catalogEntry('ton', 'TON', 9),
  catalogEntry('ton', 'USDT', 6),
]);

// Testnet reference prices in USD, used by the sandbox solver to
// price cross-asset pairs. Production pricing comes from live
// solver quotes, never from this table.
const REFERENCE_PRICES_USD = {
  BTC: '97000', WBTC: '97000', ETH: '3400', SOL: '210', XLM: '0.12',
  XRP: '2.4', TRX: '0.27', TON: '5.2', NEAR: '5', BNB: '680',
  AVAX: '38', POL: '0.45', LTC: '105', DOGE: '0.32', BCH: '460',
  ZEC: '45', USDC: '1', USDT: '1', DAI: '1', RLUSD: '1', EURC: '1.08',
};

function priceRational(symbol) {
  const raw = REFERENCE_PRICES_USD[symbol];
  if (!raw) return null;
  const [whole, fraction = ''] = raw.split('.');
  const scale = 10n ** BigInt(fraction.length);
  return { num: BigInt(whole) * scale + BigInt(fraction || '0'), den: scale };
}

export function resolveAsset(assetId) {
  const known = TOKEN_CATALOG.find((entry) => entry.assetId === assetId);
  if (known) return known;
  const match = /^([a-z0-9-]+):([A-Za-z0-9]+)(?::(.+))?$/.exec(String(assetId ?? ''));
  if (!match || !CHAINS[match[1]]) throw new Error(`unsupported asset: ${assetId}`);
  const chain = CHAINS[match[1]];
  const symbol = match[2].toUpperCase();
  const decimals = STABLE_SYMBOLS.has(symbol)
    ? 6
    : symbol === chain.nativeSymbol
      ? chain.nativeDecimals
      : chain.defaultDecimals;
  return {
    assetId: match[3] ? `${match[1]}:${symbol}:${match[3]}` : `${match[1]}:${symbol}`,
    symbol,
    chain: `${match[1]}-testnet`,
    chainId: match[1],
    decimals,
    dynamic: true,
  };
}

export function routeFor(inToken, outToken) {
  if (inToken.chainId === 'stellar' && outToken.chainId === 'stellar') {
    return 'oruva-testnet-solver';
  }
  if (
    inToken.symbol === 'USDC'
    && outToken.symbol === 'USDC'
    && CHAINS[inToken.chainId]?.cctp
    && CHAINS[outToken.chainId]?.cctp
  ) {
    return 'cctp-testnet-route';
  }
  return 'external-route-simulated';
}

function convertCross(amountIn, inToken, outToken) {
  if (inToken.symbol === outToken.symbol) {
    const scaled = amountIn * 999n * 10n ** BigInt(outToken.decimals);
    return scaled / (1000n * 10n ** BigInt(inToken.decimals));
  }
  const priceIn = priceRational(inToken.symbol);
  const priceOut = priceRational(outToken.symbol);
  if (!priceIn || !priceOut) throw new Error('no solver route for this pair');
  const scaled = amountIn * priceIn.num * priceOut.den * 10n ** BigInt(outToken.decimals);
  return scaled / (priceIn.den * priceOut.num * 10n ** BigInt(inToken.decimals));
}

function convertInverseCross(amountOut, inToken, outToken) {
  if (inToken.symbol === outToken.symbol) {
    const scaled = amountOut * 1000n * 10n ** BigInt(inToken.decimals);
    const divisor = 999n * 10n ** BigInt(outToken.decimals);
    return (scaled + divisor - 1n) / divisor;
  }
  const priceIn = priceRational(inToken.symbol);
  const priceOut = priceRational(outToken.symbol);
  if (!priceIn || !priceOut) throw new Error('no solver route for this pair');
  const scaled = amountOut * priceOut.num * priceIn.den * 10n ** BigInt(inToken.decimals);
  const divisor = priceOut.den * priceIn.num * 10n ** BigInt(outToken.decimals);
  return (scaled + divisor - 1n) / divisor;
}

function tokenOf(assetId) {
  return resolveAsset(assetId);
}

const SOLVER_ID = 'oruva-solver';

function toMinor(value, field) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${field} must be an integer string in the smallest unit`);
  }
  return BigInt(value);
}


export function createSwapApi({
  ledger = new VerifierLedger(),
  relay = new SolverRelay(),
  now = () => new Date(),
  maxWholeUnits = 10,
  protocolFeeBps = 1,
  allowAnyInput = false,
} = {}) {
  const swaps = new Map();
  const orders = new Map();

  for (const token of TOKEN_CATALOG) {
    ledger.deposit(SOLVER_ID, token.assetId, (10n ** 15n).toString());
  }

  function ensureSolverLiquidity(assetId) {
    if (BigInt(ledger.balanceOf(SOLVER_ID, assetId)) === 0n) {
      ledger.deposit(SOLVER_ID, assetId, (10n ** 15n).toString());
    }
  }

  relay.registerSolver({
    id: SOLVER_ID,
    quote: async (request) => {
      const inToken = tokenOf(request.originAsset);
      const outToken = tokenOf(request.destinationAsset);
      let amountOut;
      try {
        amountOut = convertCross(BigInt(request.amountIn), inToken, outToken);
      } catch {
        return null;
      }
      return { amountOut: amountOut.toString(), feeBps: 0, route: routeFor(inToken, outToken) };
    },
  });

  function feeBpsFor(request, inToken, outToken) {
    const sameAssetRoute = inToken.symbol === outToken.symbol;
    const stablePair = STABLE_SYMBOLS.has(inToken.symbol) && STABLE_SYMBOLS.has(outToken.symbol);
    const platformMin = sameAssetRoute || stablePair ? 1 : 20;
    let platform = platformMin;
    const app = [];
    if (Array.isArray(request.appFees) && request.appFees.length > 0) {
      platform = Math.max(platformMin, Math.floor(20 / 2));
      for (const fee of request.appFees) {
        app.push({ recipient: fee.recipient, feeBps: Number(fee.feeBps ?? 0) });
      }
    }
    const insured = request.insured ? 2 : 0;
    const appTotal = app.reduce((sum, fee) => sum + fee.feeBps, 0);
    return {
      protocolFeeBps,
      platformFeeBps: platform,
      appFees: app,
      insuredFeeBps: insured,
      totalFeeBps: protocolFeeBps + platform + appTotal + insured,
    };
  }

  function applyFees(grossOut, fees) {
    const feeAmount = (grossOut * BigInt(fees.totalFeeBps)) / 10000n;
    return { amountOut: grossOut - feeAmount, feeAmount };
  }

  function publicSwap(swap) {
    return {
      swapId: swap.swapId,
      status: swap.status,
      depositAddress: swap.depositAddress,
      depositMemo: swap.depositMemo,
      originAsset: swap.originAsset,
      destinationAsset: swap.destinationAsset,
      amountIn: swap.amountIn,
      amountOut: swap.amountOut,
      depositedAmount: swap.depositedAmount,
      refundAmount: swap.refundAmount,
      txHash: swap.txHash,
      refundTxHash: swap.refundTxHash,
      deadline: swap.deadline,
      sandbox: true,
      network: 'stellar-testnet',
    };
  }

  function settleSwap(swap, deposited) {
    const inToken = tokenOf(swap.originAsset);
    const outToken = tokenOf(swap.destinationAsset);
    const usableIn = deposited > BigInt(swap.amountIn) ? BigInt(swap.amountIn) : deposited;
    const grossOut = convertCross(usableIn, inToken, outToken);
    const { amountOut } = applyFees(grossOut, swap.fees);
    if (amountOut < BigInt(swap.minAmountOut)) {
      swap.status = 'REFUNDED';
      swap.refundAmount = deposited.toString();
      swap.refundTxHash = `sandbox-refund-${swap.swapId}`;
      return swap;
    }
    ledger.deposit(swap.ownerId, swap.originAsset, deposited.toString());
    ledger.executeIntents({
      signer_id: swap.ownerId,
      verifying_contract: VERIFYING_CONTRACT,
      deadline: new Date(now().getTime() + 60000).toISOString(),
      nonce: randomBytes(32).toString('base64'),
      intents: [
        {
          type: 'token_diff',
          diffs: [
            {
              signer_id: swap.ownerId,
              diff: { [swap.originAsset]: (-usableIn).toString(), [swap.destinationAsset]: amountOut.toString() },
            },
            {
              signer_id: SOLVER_ID,
              diff: { [swap.originAsset]: usableIn.toString(), [swap.destinationAsset]: (-amountOut).toString() },
            },
          ],
        },
      ],
    });
    ledger.withdraw(swap.ownerId, swap.destinationAsset, amountOut.toString());
    swap.status = 'SUCCESS';
    swap.amountOut = amountOut.toString();
    swap.txHash = `sandbox-settle-${swap.swapId}`;
    if (deposited > usableIn) {
      swap.refundAmount = (deposited - usableIn).toString();
      swap.refundTxHash = `sandbox-refund-${swap.swapId}`;
    }
    return swap;
  }

  return {
    tokens() {
      return {
        chains: Object.entries(CHAINS).map(([chainId, chain]) => ({
          chainId,
          family: chain.family,
          nativeSymbol: chain.nativeSymbol,
          cctp: chain.cctp,
        })),
        tokens: TOKEN_CATALOG.map((token) => ({
          ...token,
          priceUsd: REFERENCE_PRICES_USD[token.symbol] ?? null,
        })),
        assetIdFormat: 'chain:SYMBOL or chain:SYMBOL:issuer; any priced symbol on a supported chain resolves dynamically',
        network: 'stellar-testnet',
      };
    },

    async quote({ ownerId, body = {} } = {}) {
      const inToken = tokenOf(body.originAsset);
      const outToken = tokenOf(body.destinationAsset);
      const swapType = body.swapType ?? 'EXACT_INPUT';
      const slippageTolerance = Number(body.slippageTolerance ?? 100);
      if (!Number.isFinite(slippageTolerance) || slippageTolerance < 0 || slippageTolerance > 5000) {
        throw new Error('slippageTolerance must be basis points between 0 and 5000');
      }
      const amount = toMinor(body.amount, 'amount');
      if (amount === 0n) throw new Error('amount must be positive');
      const wholeCap = BigInt(maxWholeUnits) * 10n ** BigInt(inToken.decimals);
      ensureSolverLiquidity(inToken.assetId);
      ensureSolverLiquidity(outToken.assetId);

      let amountIn;
      let grossOut;
      let minAmountIn;
      if (swapType === 'EXACT_INPUT') {
        amountIn = amount;
        grossOut = convertCross(amountIn, inToken, outToken);
        minAmountIn = amountIn;
      } else if (swapType === 'EXACT_OUTPUT') {
        grossOut = amount;
        minAmountIn = convertInverseCross(grossOut, inToken, outToken);
        amountIn = (minAmountIn * BigInt(10000 + slippageTolerance)) / 10000n;
      } else if (swapType === 'FLEX_INPUT') {
        amountIn = amount;
        minAmountIn = (amountIn * BigInt(10000 - slippageTolerance)) / 10000n;
        grossOut = convertCross(amountIn, inToken, outToken);
      } else if (swapType === 'ANY_INPUT') {
        if (!allowAnyInput) throw new Error('ANY_INPUT requires partner authorization');
        amountIn = amount;
        minAmountIn = 1n;
        grossOut = convertCross(amountIn, inToken, outToken);
      } else {
        throw new Error(`unsupported swapType: ${swapType}`);
      }
      if (amountIn > wholeCap) {
        throw new Error(`sandbox amount exceeds cap of ${maxWholeUnits} whole units`);
      }

      const options = await relay.quote({
        originAsset: body.originAsset,
        destinationAsset: body.destinationAsset,
        amountIn: amountIn.toString(),
      });
      if (options.length === 0) throw new Error('no solver quote available');
      grossOut = BigInt(options[0].amountOut);

      const fees = feeBpsFor(body, inToken, outToken);
      const { amountOut, feeAmount } = applyFees(grossOut, fees);
      const minAmountOut = (amountOut * BigInt(10000 - slippageTolerance)) / 10000n;

      const quote = {
        swapType,
        originAsset: body.originAsset,
        destinationAsset: body.destinationAsset,
        amountIn: amountIn.toString(),
        minAmountIn: minAmountIn.toString(),
        amountOut: amountOut.toString(),
        minAmountOut: minAmountOut.toString(),
        slippageTolerance,
        fees: { ...fees, feeAmount: feeAmount.toString(), feeAsset: body.destinationAsset },
        solverId: options[0].solverId,
        route: options[0].route,
        refundTo: body.refundTo ?? ownerId,
        refundType: body.refundType ?? 'ORIGIN_CHAIN',
        recipient: body.recipient ?? ownerId,
        recipientType: body.recipientType ?? 'DESTINATION_CHAIN',
        depositType: body.depositType ?? 'ORIGIN_CHAIN',
        confidentiality: body.confidentiality ?? 'public',
        refundFee: '0',
        withdrawFee: '0',
        sandbox: true,
        network: 'stellar-testnet',
      };
      if (quote.confidentiality !== 'public') {
        quote.confidentialityNote = 'testnet simulation: confidential routing is modelled, no private shard settlement';
      }

      if (body.dry) return { ...quote, dry: true };

      const deadline = body.deadline
        ? new Date(body.deadline)
        : new Date(now().getTime() + 30 * 60000);
      if (Number.isNaN(deadline.getTime()) || deadline <= now()) {
        throw new Error('deadline must be in the future');
      }
      const swapId = randomUUID();
      const swap = {
        swapId,
        ownerId,
        status: 'PENDING_DEPOSIT',
        depositAddress: 'oruva-testnet-deposit',
        depositMemo: swapId,
        originAsset: body.originAsset,
        destinationAsset: body.destinationAsset,
        amountIn: amountIn.toString(),
        minAmountIn: minAmountIn.toString(),
        amountOut: amountOut.toString(),
        minAmountOut: minAmountOut.toString(),
        fees,
        depositedAmount: '0',
        refundAmount: '0',
        txHash: null,
        refundTxHash: null,
        deadline: deadline.toISOString(),
        depositType: quote.depositType,
      };
      swaps.set(swapId, swap);
      const signature = createHash('sha256')
        .update(canonicalJson({ swapId, quote }))
        .digest('hex');
      return {
        ...quote,
        dry: false,
        depositAddress: swap.depositAddress,
        depositMemo: swap.depositMemo,
        deadline: swap.deadline,
        timeWhenInactive: swap.deadline,
        signature,
      };
    },

    depositSubmit({ ownerId, body = {} } = {}) {
      const swap = swaps.get(body.depositMemo);
      if (!swap || swap.ownerId !== ownerId) throw new Error('swap not found');
      if (swap.depositAddress !== body.depositAddress) throw new Error('deposit address mismatch');
      const amount = toMinor(body.amount, 'amount');
      swap.depositedAmount = (BigInt(swap.depositedAmount) + amount).toString();
      const deposited = BigInt(swap.depositedAmount);
      if (deposited < BigInt(swap.minAmountIn)) {
        swap.status = 'INCOMPLETE_DEPOSIT';
        return publicSwap(swap);
      }
      swap.status = 'KNOWN_DEPOSIT_TX';
      swap.status = 'PROCESSING';
      try {
        settleSwap(swap, deposited);
      } catch (error) {
        swap.status = 'FAILED';
        swap.error = String(error?.message ?? error);
      }
      return publicSwap(swap);
    },

    status({ ownerId, depositMemo } = {}) {
      const swap = swaps.get(depositMemo);
      if (!swap || swap.ownerId !== ownerId) throw new Error('swap not found');
      if (
        ['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT'].includes(swap.status)
        && new Date(swap.deadline) <= now()
      ) {
        swap.status = 'REFUNDED';
        swap.refundAmount = swap.depositedAmount;
        swap.refundTxHash = `sandbox-refund-${swap.swapId}`;
      }
      return publicSwap(swap);
    },

    generateIntent({ ownerId, body = {} } = {}) {
      const swap = swaps.get(body.depositMemo ?? body.depositAddress);
      if (!swap || swap.ownerId !== ownerId) throw new Error('swap not found');
      const signerId = body.signerId ?? ownerId;
      const payload = {
        signer_id: signerId,
        verifying_contract: VERIFYING_CONTRACT,
        deadline: swap.deadline,
        nonce: randomBytes(32).toString('base64'),
        intents: [
          {
            type: 'token_diff',
            diffs: [
              {
                signer_id: signerId,
                diff: {
                  [swap.originAsset]: (-BigInt(swap.amountIn)).toString(),
                  [swap.destinationAsset]: swap.amountOut,
                },
              },
              {
                signer_id: SOLVER_ID,
                diff: {
                  [swap.originAsset]: swap.amountIn,
                  [swap.destinationAsset]: (-BigInt(swap.amountOut)).toString(),
                },
              },
            ],
          },
        ],
      };
      swap.pendingPayload = payload;
      return { payload, standard: body.standard ?? 'SEP-53', message: canonicalJson(payload) };
    },

    submitIntent({ ownerId, body = {} } = {}) {
      const swap = swaps.get(body.depositMemo);
      if (!swap || swap.ownerId !== ownerId) throw new Error('swap not found');
      if (!swap.pendingPayload) throw new Error('generate an intent first');
      const payload = body.payload ?? swap.pendingPayload;
      if (canonicalJson(payload) !== canonicalJson(swap.pendingPayload)) {
        throw new Error('signed payload must match the generated payload');
      }
      if (!body.publicKey || !body.signature) {
        throw new Error('publicKey and signature are required');
      }
      if (!verifyIntentSignature(payload, body.signature, body.publicKey)) {
        throw new Error('signature verification failed');
      }
      ledger.executeIntents(payload);
      swap.status = 'SUCCESS';
      swap.txHash = `sandbox-settle-${swap.swapId}`;
      const intentHash = createHash('sha256').update(canonicalJson(payload)).digest('hex');
      relay.recordStatus(intentHash, 'SETTLED');
      return { intentHash, status: swap.status, swap: publicSwap(swap) };
    },

    createOrder({ ownerId, body = {} } = {}) {
      const inToken = tokenOf(body.originAsset);
      tokenOf(body.destinationAsset);
      const amountIn = toMinor(body.amountIn, 'amountIn');
      if (amountIn === 0n) throw new Error('amountIn must be positive');
      if (amountIn > BigInt(maxWholeUnits) * 10n ** BigInt(inToken.decimals)) {
        throw new Error(`sandbox amount exceeds cap of ${maxWholeUnits} whole units`);
      }
      const limitAmountOut = toMinor(body.limitAmountOut, 'limitAmountOut');
      const deadline = body.deadline
        ? new Date(body.deadline)
        : new Date(now().getTime() + 7 * 24 * 60 * 60000);
      if (Number.isNaN(deadline.getTime()) || deadline <= now()) {
        throw new Error('deadline must be in the future');
      }
      const orderId = randomUUID();
      const order = {
        orderId,
        ownerId,
        status: 'AWAITING_DEPOSIT',
        originAsset: body.originAsset,
        destinationAsset: body.destinationAsset,
        amountIn: amountIn.toString(),
        limitAmountOut: limitAmountOut.toString(),
        filledAmountOut: '0',
        remainingAmountIn: amountIn.toString(),
        depositAddress: 'oruva-testnet-deposit',
        depositMemo: orderId,
        deadline: deadline.toISOString(),
        timeInForce: body.timeInForce ?? 'GTC',
        refundAmount: '0',
        sandbox: true,
        network: 'stellar-testnet',
      };
      orders.set(orderId, order);
      return { ...order };
    },

    fundOrder({ ownerId, orderId, body = {} } = {}) {
      const order = orders.get(orderId);
      if (!order || order.ownerId !== ownerId) throw new Error('order not found');
      if (order.status !== 'AWAITING_DEPOSIT') throw new Error(`order is ${order.status}`);
      const amount = toMinor(body.amount, 'amount');
      if (amount < BigInt(order.amountIn)) throw new Error('deposit below order amount');
      ledger.deposit(ownerId, order.originAsset, amount.toString());
      order.status = 'OPEN';
      return { ...order };
    },

    simulateFillOrder({ ownerId, orderId, body = {} } = {}) {
      const order = orders.get(orderId);
      if (!order || order.ownerId !== ownerId) throw new Error('order not found');
      if (!['OPEN', 'PARTIALLY_FILLED'].includes(order.status)) {
        throw new Error(`order is ${order.status}`);
      }
      const fillOut = toMinor(body.fillAmountOut, 'fillAmountOut');
      const remainingOut = BigInt(order.limitAmountOut) - BigInt(order.filledAmountOut);
      if (fillOut === 0n || fillOut > remainingOut) throw new Error('fill exceeds remaining output');
      const fillIn = (BigInt(order.amountIn) * fillOut) / BigInt(order.limitAmountOut);
      ledger.executeIntents({
        signer_id: ownerId,
        verifying_contract: VERIFYING_CONTRACT,
        deadline: new Date(now().getTime() + 60000).toISOString(),
        nonce: randomBytes(32).toString('base64'),
        intents: [
          {
            type: 'token_diff',
            diffs: [
              {
                signer_id: ownerId,
                diff: { [order.originAsset]: (-fillIn).toString(), [order.destinationAsset]: fillOut.toString() },
              },
              {
                signer_id: SOLVER_ID,
                diff: { [order.originAsset]: fillIn.toString(), [order.destinationAsset]: (-fillOut).toString() },
              },
            ],
          },
        ],
      });
      order.filledAmountOut = (BigInt(order.filledAmountOut) + fillOut).toString();
      order.remainingAmountIn = (BigInt(order.remainingAmountIn) - fillIn).toString();
      order.status = BigInt(order.filledAmountOut) >= BigInt(order.limitAmountOut)
        ? 'FILLED'
        : 'PARTIALLY_FILLED';
      return { ...order };
    },

    cancelOrder({ ownerId, orderId } = {}) {
      const order = orders.get(orderId);
      if (!order || order.ownerId !== ownerId) throw new Error('order not found');
      if (['FILLED', 'CANCELED', 'EXPIRED'].includes(order.status)) {
        throw new Error(`order is ${order.status}`);
      }
      order.status = 'PENDING_CANCEL';
      order.refundAmount = order.remainingAmountIn;
      if (BigInt(order.remainingAmountIn) > 0n && order.status !== 'AWAITING_DEPOSIT') {
        ledger.withdraw(ownerId, order.originAsset, order.remainingAmountIn);
      }
      order.remainingAmountIn = '0';
      order.status = 'CANCELED';
      return { ...order };
    },

    getOrder({ ownerId, orderId } = {}) {
      const order = orders.get(orderId);
      if (!order || order.ownerId !== ownerId) throw new Error('order not found');
      if (
        ['AWAITING_DEPOSIT', 'OPEN', 'PARTIALLY_FILLED'].includes(order.status)
        && new Date(order.deadline) <= now()
      ) {
        order.status = 'EXPIRED';
      }
      return { ...order };
    },

    listOrders({ ownerId } = {}) {
      return {
        orders: [...orders.values()]
          .filter((order) => order.ownerId === ownerId)
          .map((order) => ({ ...order })),
      };
    },

    ledgerBalances({ ownerId } = {}) {
      return { signerId: ownerId, balances: ledger.balancesOf(ownerId), sandbox: true };
    },
  };
}
