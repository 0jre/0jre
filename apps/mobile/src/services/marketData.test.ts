import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPublicQuotes } from './marketData';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const mids = { BTC: '65000', ETH: '3200', SOL: '150' };
const pair = (priceUsd: unknown = '151', liquidity = 1000) => ({
  chainId: 'solana', baseToken: { address: SOL_MINT }, priceUsd,
  liquidity: { usd: liquidity },
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

function mockFetch(
  hl: () => Response | Promise<Response>,
  sol: () => Response | Promise<Response>,
): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init?.signal instanceof AbortSignal);
    if (String(url) === 'https://api.hyperliquid.xyz/info') {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(String(init.body)), { type: 'allMids' });
      assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json');
      return hl();
    }
    assert.equal(String(url), `https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`);
    assert.equal(init.method, 'GET');
    return sol();
  }) as typeof fetch;
}

test('returns public mids and the most liquid valid Solana base-SOL pair', async () => {
  const result = await fetchPublicQuotes(mockFetch(
    () => json(mids),
    () => json({ pairs: [
      pair('149', 100), pair('152', 5000), pair('151', 1000),
      { ...pair('999', 99999), chainId: 'ethereum' },
      { ...pair('888', 99999), baseToken: { address: 'another-token' } },
    ] }),
  ));
  assert.deepEqual(result, {
    quotes: [
      { symbol: 'BTC', venue: 'Hyperliquid', price: 65000 },
      { symbol: 'ETH', venue: 'Hyperliquid', price: 3200 },
      { symbol: 'SOL', venue: 'Hyperliquid', price: 150 },
      { symbol: 'SOL', venue: 'Solana', price: 152 },
    ],
    errors: [],
  });
});

test('keeps Hyperliquid quotes when optional Solana fails HTTP', async () => {
  const result = await fetchPublicQuotes(mockFetch(
    () => json(mids), () => json({}, 429),
  ));
  assert.equal(result.quotes.length, 3);
  assert.deepEqual(result.errors, ['Solana: HTTP 429']);
});

test('keeps Solana quotes when Hyperliquid has a network failure', async () => {
  const result = await fetchPublicQuotes(mockFetch(
    () => { throw new Error('Network unavailable'); },
    () => json({ pairs: [pair()] }),
  ));
  assert.deepEqual(result.quotes, [{ symbol: 'SOL', venue: 'Solana', price: 151 }]);
  assert.deepEqual(result.errors, ['Hyperliquid: Network unavailable']);
});

test('rejects non-positive, non-finite, and non-numeric mids without fabricating data', async () => {
  for (const invalid of [0, -1, 'NaN', 'Infinity', '', 'no-price', null, true, {}, []]) {
    const result = await fetchPublicQuotes(mockFetch(
      () => json({ ...mids, BTC: invalid }), () => json({ pairs: [] }),
    ));
    assert.deepEqual(result.quotes, []);
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[0], /Invalid or missing BTC price/);
  }
});

test('rejects invalid Solana prices and liquidity', async () => {
  for (const invalid of [0, -1, 'NaN', 'Infinity', '', null, true]) {
    const result = await fetchPublicQuotes(mockFetch(
      () => json(mids),
      () => json({ pairs: [pair(invalid), pair('151', -1)] }),
    ));
    assert.equal(result.quotes.length, 3);
    assert.match(result.errors[0], /No liquid Solana SOL pair/);
  }
});

test('reports malformed response shapes and missing mids', async () => {
  for (const malformed of [null, [], 'wrong', {}, { BTC: '1' }]) {
    const result = await fetchPublicQuotes(mockFetch(
      () => json(malformed), () => json({ pairs: null }),
    ));
    assert.deepEqual(result.quotes, []);
    assert.equal(result.errors.length, 2);
  }
});

test('reports malformed JSON independently for both sources', async () => {
  const result = await fetchPublicQuotes(mockFetch(
    () => new Response('{not json'), () => new Response('not json'),
  ));
  assert.deepEqual(result.quotes, []);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /^Hyperliquid:/);
  assert.match(result.errors[1], /^Solana:/);
});

test('aborts stalled fetches after the source timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  const fetcher = ((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    signals.push(signal);
    signal.addEventListener('abort', () => reject(new Error('Request timed out')), { once: true });
  })) as typeof fetch;
  const pending = fetchPublicQuotes(fetcher);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => !signal.aborted));
  t.mock.timers.tick(10_000);
  const result = await pending;
  assert.ok(signals.every((signal) => signal.aborted));
  assert.deepEqual(result.quotes, []);
  assert.deepEqual(result.errors, ['Hyperliquid: Request timed out', 'Solana: Request timed out']);
});
