# Orbit — Expo trading workspace

Mobile-first Portuguese interface for web, Android and iOS, with separate **paper** and **connected** trading flows. The portfolio/markets/agents remain an explicitly illustrative simulator; they never spend a real wallet balance.

## Run and validate

At repository root, Node22.13+:

```bash
npm ci --ignore-scripts
npm start
npm run web
npm run typecheck
npm test
npm run build:web
npm run api
```

Web export: `apps/mobile/dist`. API setup/contracts/security: [backend README](../api/README.md), [venue adapters](../api/VENUES.md), [environment template](../../.env.example). Public `EXPO_PUBLIC_PRIVY_APP_ID`, `EXPO_PUBLIC_PRIVY_CLIENT_ID` and optionally `EXPO_PUBLIC_API_URL` are build-time settings. Private API keys never go in these variables.

Native Privy requires an **Expo development build, not Expo Go**. Install native toolchains and run `npx expo run:android` / `npx expo run:ios` inside this app, or use your EAS development-build pipeline. Platform-specific entries load Privy polyfills first on native; web uses its separate SDK. Scheme: `orbit-agent-trading`. The Privy app must authorize your actual web origin/native app identifiers and email login/embedded wallets. Configure an externally reachable HTTPS API for native. Device builds/login/signatures were not verified on this Linux machine.

## Connected flow

Open the settings tab: Privy email OTP, sign-out, Ethereum/Solana wallet creation, current bearer identity verification. Connected trading separately loads the authenticated server's balances, risk and orders. Spot ticket: mint addresses and **atomic-unit** input, route review, explicit wallet signing then backend dispatch. Perp ticket: decimal size/limit price, exact typed-data review/signing, then dispatch. Review/order reconciliation/cancel apply to server intents, not the local paper history. No configuration means an explicit demo/unavailable state, not fake authentication. Dispatch is disabled on the server by default; missing credentials fail closed.

## Paper/data behavior

$10,000 fictitious account, spot/long/short, isolated simulated margin1–10×, PnL, manual one-step deterministic agents, cumulative notional budgets, kill switch, history and AsyncStorage persistence. The copiloto is not an LLM. Eight seed markets, candles, changes/volumes and pool labels are illustrative. Optional public Hyperliquid BTC/ETH/SOL mids and DexScreener SOL snapshots update only quotes, not the rest of the simulated chart/feed. Quotes are not persisted; reload can revalue paper positions against seed prices until refreshed. No continuous liquidation, funding, fees, oracle or MEV guarantee is simulated.

Jupiter is the real Solana adapter, Hyperliquid the perpetual adapter; live access has not been exercised with funds. No all-token/all-pool coverage, direct Pump/Meteora/GMGN integration or autonomous delegated AI execution is claimed. Never enter a seed phrase/private key in the app.

## Dependency security

Expo58/React19.3/RN0.88, SDK-isolated providers. Compatible overrides patch fingerprint minimatch, viem2, ws8, abitype1 and WalletConnect utils2. Workspace audit still has **23 advisories (13 high/10 moderate)** in upstream zod3/uuid/stream-json chains. See backend README. Not certified production-safe; no unsafe major overrides or hidden vulnerable functionality removal. One optional Solana dependency declares Node>=24, so validate the native release toolchain accordingly.
