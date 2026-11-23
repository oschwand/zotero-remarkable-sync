import { assert } from "chai";
import { initAnnotations } from "../src/modules/remarkable/annotations";
import { connectCloud, register } from "../src/modules/remarkable/cloud";
import * as client from "../src/modules/remarkable/client";
import { WASM_URL } from "../src/modules/remarkable/wasm";
import { ensureNetworkGlobals } from "../src/utils/globals";
import { getPref, setPref } from "../src/utils/prefs";

describe("cloud server", function () {
  before(async function () {
    ensureNetworkGlobals();
    const response = await fetch(WASM_URL);
    initAnnotations(new Uint8Array(await response.arrayBuffer()));
  });

  it("normalizes and validates custom URLs", function () {
    assert.equal(
      client.normalizeServerUrl("  https://example.com/base/// "),
      "https://example.com/base",
    );
    assert.equal(client.normalizeServerUrl(" "), "");
    for (const url of [
      "not a URL",
      "ftp://example.com",
      "https://" + "user" + "@" + "example.com",
      "https://example.com/?query=1",
      "https://example.com/#fragment",
    ]) {
      assert.throws(() => client.normalizeServerUrl(url));
    }
  });

  it("routes registration, authentication and file reads to the selected server", async function () {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const token = "header.eyJkZXZpY2UtaWQiOiJ0ZXN0In0.signature";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const text = url.endsWith("/device/new")
        ? "device-token"
        : url.endsWith("/user/new")
          ? token
          : "file contents";
      const bytes = new TextEncoder().encode(text);
      return {
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => bytes.buffer,
      } as Response;
    }) as typeof fetch;
    try {
      for (const server of [undefined, "https://example.com/base"]) {
        calls.length = 0;
        const deviceToken = await register(
          "abcdefgh",
          "browser-chrome",
          server,
        );
        const api = await connectCloud(deviceToken, server);
        await api.raw.getHash({ id: "file", hash: "a".repeat(64) });
        const auth =
          server ?? "https://webapp-prod.cloud.remarkable.engineering";
        const raw = server ?? "https://eu.tectonic.remarkable.com";
        assert.deepEqual(calls, [
          `${auth}/token/json/2/device/new`,
          `${auth}/token/json/2/user/new`,
          `${raw}/sync/v3/files/${"a".repeat(64)}`,
        ]);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not use a device token after the server changes", async function () {
    const token = getPref("deviceToken");
    const server = getPref("serverUrl");
    const tokenServer = getPref("deviceTokenServerUrl");
    try {
      setPref("deviceToken", "device-token");
      setPref("deviceTokenServerUrl", "");
      setPref("serverUrl", "");
      assert.isTrue(client.isConnected());
      setPref("serverUrl", "https://example.com/");
      assert.isFalse(client.isConnected());
      try {
        await client.getApi();
        assert.fail("Expected a connection error");
      } catch (e) {
        assert.instanceOf(e, client.NotConnectedError);
      }
      setPref("deviceTokenServerUrl", "https://example.com");
      assert.isTrue(client.isConnected());
    } finally {
      setPref("deviceToken", token);
      setPref("serverUrl", server);
      setPref("deviceTokenServerUrl", tokenServer);
      client.resetApi();
    }
  });
});
