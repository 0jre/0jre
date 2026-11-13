# Live venue gateways

`src/venues.ts` is the non-custodial provider boundary. `createVenueGateway(config, fetcher?)` implements the shared `VenueGateway` contract. Injecting fetch makes all gateway tests deterministic; tests generate and sign transactions locally and never contact a trading venue.

## Configuration and ownership

- `jupiterApiKey`: server-only Jupiter key. Missing keys return `VenueError` HTTP 503; there is no fake quote or simulated-live fallback.
- `solanaRpcUrl`: trusted operator-selected RPC endpoint, never accepted from a client.
- `hyperliquidTestnet`: explicitly selects the mainnet or testnet endpoint and SDK EIP-712 source domain.
- Dependencies: `@solana/web3.js`, `@nktkas/hyperliquid`, `viem`, and Node's built-in `crypto`.

The API must authenticate linked wallets, persist complete quotes and prepared payloads server-side, enforce risk checks, use monotonic per-wallet nonces and deterministic client order IDs, and implement durable idempotency. Submit methods must receive the **stored** preparation, not a client-supplied replacement. The gateway does not replace the API's authorization or persistence layer.

## Jupiter and Solana

Jupiter's current documentation labels Swap V1 unmaintained, so this implementation uses maintained `GET https://api.jup.ag/swap/v2/order` with `x-api-key`. It binds the taker, requests `ExactIn` with explicit slippage, and requests version 0 transactions. Non-Metis routers are excluded because this gateway supports RPC simulation/submission, not Jupiter's managed RFQ `/execute` flow. Preparation reuses the exact transaction from the persisted quote; it does not get a different route after approval.

Only wallet-funded fee-payer transactions are supported. Sponsored/gasless transactions whose fee payer is not the linked wallet fail closed. A provider can return a quote but fail transaction construction (insufficient SOL, funds, or minimum size); preparation rejects that rather than inventing a transaction. This subset deliberately does not claim support for RFQ, sponsored gas, or Solana transaction version 1.

Before submission, the gateway:

1. Strictly base64-decodes and deserializes both stored and signed transactions.
2. Compares serialized messages byte-for-byte, including instruction data, accounts, fee payer, and blockhash.
3. Requires the linked wallet as fee payer and verifies **every required Ed25519 signature** over that exact message using Node crypto. Zero, missing, and corrupted signatures are rejected before any RPC request.
4. Checks current confirmed block height against the stored last-valid height.
5. Simulates with `sigVerify: true`, `replaceRecentBlockhash: false`, and confirmed commitment.
6. Sends only that signed transaction, with preflight enabled, after successful simulation.

A returned signature means `submitted`, never filled. Signature-status reads report `confirmed` only from confirmed/finalized network status. This is network confirmation, not independently proven swap amounts or economic fill accounting.

Spot USD risk valuation assumes canonical Solana USDC's six decimals: use exact USDC input/output amounts when present, otherwise independently quote the same input amount into canonical USDC. Missing/invalid valuation fails closed. User-provided USD values and token decimals are never used. As with any quote-based notional, this is not a guarantee of eventual execution value or USDC's dollar peg.

## Hyperliquid

Preparation fetches `meta` and current `allMids`. The universe index determines the perpetual asset ID; `szDecimals` controls exact size atoms and the `6 - szDecimals` price-decimal constraint. Fractional prices allow at most five significant figures; integer prices remain allowed. Decimal input is normalized without rounding and converted through BigInt for safe atomic range validation. The conservative notional uses the greater of current mid and limit price.

The only prepared action is a single GTC limit order with explicit buy/sell, size, limit price, reduce-only, and a deterministic parent-supplied 128-bit cloid. There are no transfers, withdrawals, leverage changes, vaults, agent-wallet delegations, trigger orders, or market-order shortcuts.

The installed SDK's exported `signL1Action` owns hashing and complete phantom-agent typed-data construction. A capture-only wallet callback receives the payload and deliberately aborts signing; no private key or synthetic signature is used. Submission regenerates this SDK payload from the stored action/nonce/expiry and checks it matches the persisted signing payload. `viem` recovers the actual EVM signer and requires the bound linked wallet before posting the **stored** action to `/exchange`. The expiry is short and included in the SDK hash and exchange request. HTTP 200 is not enough: top-level and individual order statuses are checked, and per-order errors reject submission. Reconciliation reads `orderStatus` by exact cloid and wallet.

## Live reads

- Solana portfolio: confirmed native SOL plus parsed SPL Token and Token-2022 accounts.
- Ethereum-linked Hyperliquid portfolio: actual clearinghouse balances/positions and spot balances. This is Hyperliquid account state, not Ethereum mainnet ERC-20 inventory.
- Markets: `metaAndAssetCtxs` metadata joined by universe index with current mark/funding/volume context, tagged with mainnet/testnet identity.

## Verification and limits

Run `npx tsx --test apps/api/src/venues.test.ts`. Tests use offline Ed25519 and EIP-712 signatures, injected mock provider fetch, altered messages/actions/signatures, expired transactions, simulation failures, nested order errors, and explicit HTTP/network failures. No tests send a real transaction, order, or provider request.

Live provider authentication, RPC simulation against real account state, actual transaction landing, and funded Hyperliquid order execution are **not verified by these unit tests**. An authorized funded-wallet end-to-end test remains a distinct operational check; do not interpret passing mocks as proof of a deployed trading system.

## References checked

- [Current Jupiter order API](https://developers.jup.ag/docs/api-reference/swap/order)
- [Jupiter Swap V1 deprecation notice](https://dev.jup.ag/api-reference/swap/quote)
- [Hyperliquid exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)
- [Hyperliquid tick and lot size](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size)
- [Hyperliquid info/status endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- Installed `@nktkas/hyperliquid` signing exports and `signL1Action` implementation.
