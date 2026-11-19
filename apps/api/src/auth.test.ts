import test from "node:test";
import assert from "node:assert/strict";
import {
  createPrivyAuthenticator,
  type PrivyAuthDependencies,
} from "./auth.js";
const appId = "test-app",
  userId = "did:privy:test";
const sol = "So11111111111111111111111111111111111111112";
const evm = "0x1234567890123456789012345678901234567890";
const config = { appId, appSecret: "test-only-not-a-real-secret" };
const claims = () => ({
  app_id: appId,
  user_id: userId,
  issuer: "privy.io",
  expiration: Date.now() / 1000 + 3600,
  issued_at: Date.now() / 1000 - 10,
});
const deps = (): PrivyAuthDependencies => ({
  verifyAccessToken: async () => claims(),
  getUser: async () => ({
    id: userId,
    linked_accounts: [
      { type: "wallet", chain_type: "solana", address: sol },
      { type: "wallet", chain_type: "ethereum", address: evm },
      { type: "email", address: "not-a-wallet" },
      { type: "wallet", chain_type: "solana", address: "fake" },
      { type: "wallet", chain_type: "ethereum", address: evm },
    ],
  }),
});
test("Privy auth refuses missing configuration and failed SDK signature verification", async () => {
  await assert.rejects(
    createPrivyAuthenticator({ appId: "", appSecret: "" }).verify("token"),
    { statusCode: 503 },
  );
  let lookup = false;
  const sdk = deps();
  sdk.verifyAccessToken = async () => {
    throw Error("invalid signature");
  };
  sdk.getUser = async () => {
    lookup = true;
    throw Error();
  };
  await assert.rejects(createPrivyAuthenticator(config, sdk).verify("forged"), {
    statusCode: 401,
  });
  assert.equal(lookup, false);
});
test("Privy auth derives wallets only from current verified user, validates and deduplicates", async () => {
  const sdk = deps();
  let lookedUp = "";
  const get = sdk.getUser;
  sdk.getUser = async (id) => {
    lookedUp = id;
    return get(id);
  };
  const out = await createPrivyAuthenticator(config, sdk).verify("valid");
  assert.equal(out.userId, userId);
  assert.equal(lookedUp, userId);
  assert.deepEqual(out.wallets, [
    { address: sol, chain: "solana" },
    { address: evm, chain: "ethereum" },
  ]);
});
test("Privy auth rejects wrong audience, issuer, subject, expired/future/malformed claims", async () => {
  for (const patch of [
    { app_id: "other" },
    { issuer: "other" },
    { user_id: "user" },
    { expiration: 0 },
    { expiration: NaN },
    { issued_at: Date.now() / 1000 + 1000 },
  ]) {
    const sdk = deps();
    sdk.verifyAccessToken = async () => ({ ...claims(), ...patch });
    await assert.rejects(
      createPrivyAuthenticator(config, sdk).verify("token"),
      { statusCode: 401 },
    );
  }
});
test("Privy ownership lookup fails closed on unavailable provider or wrong returned user", async () => {
  const sdk = deps();
  sdk.getUser = async () => {
    throw Error("provider down");
  };
  await assert.rejects(createPrivyAuthenticator(config, sdk).verify("token"), {
    statusCode: 503,
  });
  sdk.getUser = async () => ({ id: "did:privy:other", linked_accounts: [] });
  await assert.rejects(createPrivyAuthenticator(config, sdk).verify("token"), {
    statusCode: 401,
  });
});
test("Privy client allowlist reads claims only after signature verification and rejects missing or wrong client", async () => {
  const sdk = deps();
  const token = (client: unknown) =>
    "header." +
    Buffer.from(JSON.stringify({ app_client_id: client })).toString(
      "base64url",
    ) +
    ".verified";
  const auth = createPrivyAuthenticator(
    { ...config, allowedClientIds: ["mobile"] },
    sdk,
  );
  assert.equal((await auth.verify(token("mobile"))).userId, userId);
  for (const client of ["root", "other", undefined])
    await assert.rejects(auth.verify(token(client)), { statusCode: 403 });
});
test("wallet unlink is reflected on every request, not stale cached ownership", async () => {
  const sdk = deps();
  const auth = createPrivyAuthenticator(config, sdk);
  assert.equal((await auth.verify("token")).wallets.length, 2);
  sdk.getUser = async () => ({ id: userId, linked_accounts: [] });
  assert.equal((await auth.verify("token")).wallets.length, 0);
});
