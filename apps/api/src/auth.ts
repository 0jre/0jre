import { PrivyClient } from "@privy-io/node";
import { PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";
import type { Authenticator, Identity, Wallet } from "./contracts.js";
import { ApiError } from "./store.js";
interface Claims {
  app_id: string;
  user_id: string;
  issuer: string;
  expiration: number;
  issued_at: number;
}
interface User {
  id: string;
  linked_accounts: unknown[];
}
export interface PrivyAuthDependencies {
  verifyAccessToken(token: string): Promise<Claims>;
  getUser(id: string): Promise<User>;
}
/** Only verified access-token subjects drive user lookup. SDK seams are test-only constructor injection, never environment switches. */
export function createPrivyAuthenticator(
  config: { appId: string; appSecret: string; allowedClientIds?: string[] },
  dependencies?: PrivyAuthDependencies,
): Authenticator {
  let sdk: PrivyAuthDependencies | undefined = dependencies;
  if (!sdk && config.appId && config.appSecret) {
    const client = new PrivyClient({
      appId: config.appId,
      appSecret: config.appSecret,
    });
    sdk = {
      verifyAccessToken: (token) =>
        client.utils().auth().verifyAccessToken(token),
      getUser: (id) => client.users()._get(id),
    };
  }
  return {
    async verify(token: string): Promise<Identity> {
      if (!config.appId || !config.appSecret || !sdk)
        throw new ApiError(
          503,
          "privy_not_configured",
          "Privy is not configured.",
        );
      if (!token || token.length > 16000)
        throw new ApiError(401, "invalid_token", "Invalid Privy access token.");
      let claims: Claims;
      try {
        claims = await sdk.verifyAccessToken(token);
      } catch {
        throw new ApiError(
          401,
          "invalid_token",
          "Invalid or expired Privy access token.",
        );
      }
      const now = Date.now() / 1000;
      if (
        claims.app_id !== config.appId ||
        claims.issuer !== "privy.io" ||
        !claims.user_id?.startsWith("did:privy:") ||
        !Number.isFinite(claims.expiration) ||
        claims.expiration <= now ||
        !Number.isFinite(claims.issued_at) ||
        claims.issued_at > now + 60
      )
        throw new ApiError(
          401,
          "invalid_token",
          "Invalid or expired Privy access token.",
        );
      // The SDK has already authenticated this exact JWT. Read the client claim only AFTER verification.
      if (config.allowedClientIds?.length) {
        let clientId: unknown;
        try {
          const payload = JSON.parse(
            Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
          );
          clientId = payload.app_client_id;
        } catch {
          throw new ApiError(401, "invalid_token", "Malformed access token.");
        }
        if (
          typeof clientId !== "string" ||
          !config.allowedClientIds.includes(clientId)
        )
          throw new ApiError(
            403,
            "client_not_allowed",
            "This app client is not authorized.",
          );
      }
      let user: User;
      try {
        user = await sdk.getUser(claims.user_id);
      } catch {
        throw new ApiError(
          503,
          "privy_unavailable",
          "Unable to verify current wallet ownership.",
        );
      }
      if (user.id !== claims.user_id || !Array.isArray(user.linked_accounts))
        throw new ApiError(
          401,
          "invalid_user",
          "Unable to verify the authenticated user.",
        );
      const wallets: Wallet[] = [];
      for (const raw of user.linked_accounts) {
        if (!raw || typeof raw !== "object") continue;
        const record = raw as Record<string, unknown>;
        if (
          record.type !== "wallet" ||
          typeof record.address !== "string" ||
          !["solana", "ethereum"].includes(String(record.chain_type))
        )
          continue;
        const chain = record.chain_type as Wallet["chain"];
        let address = record.address;
        try {
          if (chain === "solana") {
            if (new PublicKey(address).toBase58() !== address) continue;
          } else {
            if (!isAddress(address)) continue;
            address = address.toLowerCase();
          }
        } catch {
          continue;
        }
        if (!wallets.some((w) => w.chain === chain && w.address === address))
          wallets.push({
            address,
            chain,
            ...(typeof record.id === "string" ? { id: record.id } : {}),
          });
      }
      return { userId: claims.user_id, wallets };
    },
  };
}
