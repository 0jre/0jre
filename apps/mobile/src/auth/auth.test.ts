import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { verifyBackendIdentity } from "./verifyIdentity";
import { demoSession, typedDataJson } from "./WalletSession";

test("unconfigured session is explicitly demo and cannot sign or authenticate", async () => {
  assert.equal(demoSession.configured, false);
  assert.equal(demoSession.userId, null);
  assert.deepEqual(demoSession.wallets, []);
  assert.equal(await demoSession.getAccessToken(), null);
  await assert.rejects(
    demoSession.signSolanaTransaction("not-a-transaction"),
    /Privy/,
  );
  await assert.rejects(demoSession.signTypedData({}), /Privy/);
});
test("identity check obtains a fresh bearer each time, verifies user and uses same-origin web URL", async () => {
  let calls = 0;
  const options = {
    userId: "did:privy:test",
    apiUrl: "",
    requireApiUrl: false,
    getAccessToken: async () => `test-token-${++calls}`,
    fetcher: (async (url, init) => {
      assert.equal(url, "/v1/me");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        `Bearer test-token-${calls}`,
      );
      assert.equal(init?.cache, "no-store");
      return Response.json({ userId: "did:privy:test" });
    }) as typeof fetch,
  };
  assert.equal(await verifyBackendIdentity(options), options.userId);
  assert.equal(await verifyBackendIdentity(options), options.userId);
  assert.equal(calls, 2);
});
test("identity check fails closed for missing config/session, rejection and identity mismatch", async () => {
  let fetched = false;
  const options = {
    userId: "did:privy:test",
    apiUrl: "",
    requireApiUrl: true,
    getAccessToken: async () => null,
    fetcher: (async () => {
      fetched = true;
      return Response.json({});
    }) as typeof fetch,
  };
  await assert.rejects(verifyBackendIdentity(options), /EXPO_PUBLIC_API_URL/);
  await assert.rejects(
    verifyBackendIdentity({ ...options, requireApiUrl: false }),
    /Sessão/,
  );
  assert.equal(fetched, false);
  await assert.rejects(
    verifyBackendIdentity({
      ...options,
      apiUrl: "https://backend.test/",
      getAccessToken: async () => "test",
      fetcher: (async () => new Response("", { status: 401 })) as typeof fetch,
    }),
    /não aceitou/,
  );
  await assert.rejects(
    verifyBackendIdentity({
      ...options,
      apiUrl: "https://backend.test",
      getAccessToken: async () => "test",
    }),
    /não corresponde/,
  );
});
test("typed data validation preserves exact EIP-712 payload", () => {
  const data = {
    domain: { name: "Exchange" },
    types: { Order: [] },
    primaryType: "Order",
    message: { nonce: 1 },
  };
  assert.deepEqual(JSON.parse(typedDataJson(data)), data);
  assert.throws(() => typedDataJson({ message: {} }), /inválido/);
});
test("native entry loads documented polyfills first and web provider excludes native SDK", () => {
  const native = readFileSync(
    new URL("../../index.native.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    native,
    /import '@privy-io\/expo\/polyfills';\s*import '\.\/src\/auth\/register';/,
  );
  const web = readFileSync(
    new URL("./WalletProvider.web.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(web, /@privy-io\/expo/);
  for (const filename of [
    "./WalletProvider.web.tsx",
    "./WalletProvider.native.tsx",
  ]) {
    const source = readFileSync(new URL(filename, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /signAndSendTransaction|sendRawTransaction|eth_sendTransaction|console\./,
    );
  }
});
