import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import staticFiles from "@fastify/static";
import { buildServer } from "./server.js";
import { Store, ApiError } from "./store.js";
import { createPrivyAuthenticator } from "./auth.js";
import { createVenueGateway } from "./venues.js";

const env = z
  .object({
    PORT: z.coerce.number().int().min(1024).max(65535).default(8081),
    HOST: z.string().default("0.0.0.0"),
    DATABASE_PATH: z.string().default("./data/orbit.sqlite"),
    PRIVY_APP_ID: z.string().optional(),
    PRIVY_APP_SECRET: z.string().optional(),
    PRIVY_ALLOWED_CLIENT_IDS: z.string().optional(),
    JUPITER_API_KEY: z.string().optional(),
    SOLANA_RPC_URL: z.url().default("https://api.mainnet-beta.solana.com"),
    HYPERLIQUID_TESTNET: z.enum(["true", "false"]).default("true"),
    LIVE_EXECUTION_ENABLED: z.enum(["true", "false"]).default("false"),
    CORS_ORIGINS: z.string().default(""),
    STATIC_DIR: z.string().default("apps/mobile/dist"),
  })
  .parse(process.env);
const auth =
  env.PRIVY_APP_ID && env.PRIVY_APP_SECRET
    ? createPrivyAuthenticator({
        appId: env.PRIVY_APP_ID,
        appSecret: env.PRIVY_APP_SECRET,
        allowedClientIds: env.PRIVY_ALLOWED_CLIENT_IDS?.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      })
    : {
        verify: async () => {
          throw new ApiError(
            503,
            "privy_not_configured",
            "Privy is not configured on this server.",
          );
        },
      };
const app = await buildServer({
  store: new Store(env.DATABASE_PATH),
  auth,
  venues: createVenueGateway({
    jupiterApiKey: env.JUPITER_API_KEY,
    solanaRpcUrl: env.SOLANA_RPC_URL,
    hyperliquidTestnet: env.HYPERLIQUID_TESTNET === "true",
  }),
  executionEnabled: env.LIVE_EXECUTION_ENABLED === "true",
  corsOrigins: env.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  logger: true,
});
if (existsSync(resolve(env.STATIC_DIR, "index.html")))
  await app.register(staticFiles, {
    root: resolve(env.STATIC_DIR),
    prefix: "/",
    wildcard: false,
  });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
await app.listen({ host: env.HOST, port: env.PORT });
