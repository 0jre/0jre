# Orbit API

Fastify 5, persistent SQLite and the official Privy Node SDK. Implements authenticated trading intents, client-side signing, guarded dispatch and reconciliation. Not an audited exchange or a complete GMGN clone. Paper balances never fund live orders.

## Run

Node 22.13+ is used in CI. The built-in `node:sqlite` API is experimental; an optional upstream Solana dependency declares Node >=24, so native release toolchains also need validation on Node 24.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build:web
# Populate the ignored .env from .env.example using your secret manager.
node --env-file=.env --import tsx apps/api/src/index.ts
```

`npm run api` starts with already-injected configuration. Default listener: 0.0.0.0:8081; serves the mobile web export if present. The public Privy app/client IDs must be set when bundling. Web uses the same API origin unless `EXPO_PUBLIC_API_URL` is set; native needs an externally reachable HTTPS API. Never expose the app secret, Jupiter key, bearer or RPC credentials in `EXPO_PUBLIC_*`.

**Dispatch defaults OFF.** `LIVE_EXECUTION_ENABLED=true` explicitly enables signed funded transactions for authenticated users. Hyperliquid defaults to testnet; **Solana/Jupiter still use mainnet**, independently. This setting is not a universal testnet switch. No funded orders, actual OTP, wallet creation, real signing or native device build was exercised during implementation.

## Authentication

Every `/v1` route requires a fresh `Authorization: Bearer` Privy access token. The official SDK verifies it; the API checks audience, issuer, expiry, subject and optional signed client-ID allowlist. Each request looks up the current user's linked wallets at Privy rather than trusting JSON wallet claims or a stale cache. Missing configuration and identity-provider failures fail closed. Private keys and tokens are not stored by this API.

## Routes

- Public `GET /health`: health and execution-switch state.
- `GET /v1/me`, `/v1/markets`, `/v1/portfolio`: verified identity, metadata and linked-wallet balances/positions; individual wallet failures are reported independently.
- `GET|PATCH /v1/risk`: kill switch, integer-cent order/daily notional caps and slippage bps.
- `GET|POST /v1/agents`, `PATCH /v1/agents/:id`: owner-scoped wallet/venue/symbol/order/cumulative budgets and pause. These are authorization scopes, **not LLM workers or separately authenticated signing delegates**.
- `POST /v1/quotes/spot`: `{walletAddress,inputMint,outputMint,amount,slippageBps}`. Amount is an atomic-unit integer string, never USD. Returns short-lived quote, valuation and route.
- `POST /v1/orders/spot`: `{quoteId,agentId?}` with stable `Idempotency-Key`. Returns exact unsigned Solana transaction.
- `POST /v1/orders/perp`: `{walletAddress,symbol,side,size,limitPrice,reduceOnly,agentId?}` with `Idempotency-Key`. Decimal-string size/price; returns Hyperliquid EIP-712 payload and durable wallet-scoped nonce/client order ID.
- `GET /v1/orders`, `/v1/orders/:id`: owner-scoped history and stored intent/status.
- `POST /v1/orders/:id/submit`: `{signedTransactionBase64}` or `{signature}`. Dispatches the **stored** intent, never a replacement action supplied by the client. Signing alone does not submit.
- `POST /v1/orders/:id/reconcile`: queries the stored signature/order ID without sending again.
- `POST /v1/orders/:id/cancel`: cancels only an unsigned, unsubmitted **local intent**, not a live venue order.
- `GET /v1/audit`: owner-scoped audit log.

Timeout/ambiguous dispatch: reconcile the same order ID; never create a replacement key/order automatically. HTTP 200 alone does not prove an exchange fill. Solana confirmation is not economic token accounting.

## Risk and lifecycle

SQLite transactions atomically enforce user/agent scopes and reserve integer-cent notional across concurrent requests. Current policy/slippage and valuation are checked at preparation and immediately before dispatch, including other reservations. Hyperliquid values max(limit,current mid) × size. Signature/message/fee-payer, Solana expiry and fresh RPC simulation, Hyperliquid precision/metadata/signature are validated.

Interrupted submissions become unknown on startup, not retried. Ambiguous outcomes retain reservations. Late async results cannot overwrite a recorded terminal fill/confirmation. Partial-fill/canceled perpetuals conservatively retain the full original notional until a proper fill ledger exists. Agent budgets are cumulative and not refunded on closes. The kill switch blocks new dispatch, **not existing venue orders or positions**. Reduce-only orders still require policy/signature allowance.

Notional gates are not portfolio margin, liquidation, loss, market-impact or balance guarantees. External wallet trades can change positions. The API does not set leverage/margin mode, withdraw, bridge or cancel/amend already-live orders. The paper 10× selector is not a real exchange leverage setting.

## Deployment

Run **one process** with one persistent private volume for `DATABASE_PATH`, not multiple instances or ephemeral/serverless storage: startup recovery assumes exclusive ownership. Use HTTPS, explicit `CORS_ORIGINS` when hosting web separately, edge rate limiting/monitoring and a reliable RPC. Rate limiting here is per-process/IP; `trustProxy=false` avoids trusting arbitrary forwarded headers. Back up SQLite consistently using its backup API or a stopped service; copying only the database while WAL is active is unsafe. Protect backups/history as user data. Reconcile unknown orders operationally rather than deleting or replacing them. Never log signed payloads, bearer tokens or secrets.

## Coverage and outstanding security

See [venue contracts](VENUES.md). Jupiter routing is the Solana integration; route labels do not promise every Pump/Meteora pool, launch or token. No direct Pump/Meteora/GMGN integration, indexing service, WebSocket feed, autonomous AI runner, delegated backend signer, economic PnL ledger or live cancel/amend API is implemented.

Workspace `npm audit`: **23 advisories (13 high, 10 moderate)** after compatible remediation. Remaining roots include upstream zod3, uuid<11.1.1 and stream-json1 through legacy web3/jayson; unsafe SDK-breaking major overrides were not applied. This is a material security limitation, not a production certification. Test real authentication, signatures, funded testnet lifecycle and native devices before enabling dispatch; default-off is not a vulnerability fix.
