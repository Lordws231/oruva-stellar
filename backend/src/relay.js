// Oruva Intents solver relay (message bus model).
//
// Solvers register a quote function. A quote request fans out to
// every connected solver with a short timeout, and the relay returns
// the surviving options best-first. Publishing a batch of signed
// intents reports per-intent results so failed entries can be
// requoted without failing the whole batch.

export const RELAY_STATUSES = Object.freeze([
  'PENDING',
  'TX_BROADCASTED',
  'SETTLED',
  'NOT_FOUND_OR_NOT_VALID',
]);

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('solver quote timed out')), timeoutMs);
    }),
  ]);
}

export class SolverRelay {
  constructor({ quoteTimeoutMs = 3000 } = {}) {
    this.quoteTimeoutMs = quoteTimeoutMs;
    this.solvers = new Map();
    this.statuses = new Map();
  }

  registerSolver({ id, quote } = {}) {
    if (typeof id !== 'string' || id.trim() === '') throw new Error('solver id is required');
    if (typeof quote !== 'function') throw new Error('solver quote function is required');
    this.solvers.set(id.trim(), quote);
    return { id: id.trim(), solvers: this.solvers.size };
  }

  async quote(request = {}) {
    const attempts = [...this.solvers.entries()].map(async ([id, quoteFn]) => {
      const option = await withTimeout(Promise.resolve().then(() => quoteFn(request)), this.quoteTimeoutMs);
      if (!option) return null;
      return { solverId: id, ...option };
    });
    const settled = await Promise.allSettled(attempts);
    const options = settled
      .filter((entry) => entry.status === 'fulfilled' && entry.value)
      .map((entry) => entry.value)
      .sort((a, b) => {
        const outA = BigInt(a.amountOut ?? '0');
        const outB = BigInt(b.amountOut ?? '0');
        if (outA !== outB) return outA > outB ? -1 : 1;
        return Number(a.feeBps ?? 0) - Number(b.feeBps ?? 0);
      });
    return options;
  }

  async publishIntents(intents, executor) {
    const results = [];
    for (const intent of intents) {
      try {
        const result = await executor(intent);
        results.push({ ok: true, intent, result });
      } catch (error) {
        results.push({ ok: false, intent, error: String(error?.message ?? error) });
      }
    }
    return {
      results,
      settled: results.filter((entry) => entry.ok).length,
      failed: results.filter((entry) => !entry.ok),
    };
  }

  recordStatus(intentHash, status) {
    if (!RELAY_STATUSES.includes(status)) throw new Error(`unknown relay status: ${status}`);
    this.statuses.set(intentHash, status);
    return { intentHash, status };
  }

  getStatus(intentHash) {
    return this.statuses.get(intentHash) ?? 'NOT_FOUND_OR_NOT_VALID';
  }
}

export function createSolverRelay(options = {}) {
  return new SolverRelay(options);
}
