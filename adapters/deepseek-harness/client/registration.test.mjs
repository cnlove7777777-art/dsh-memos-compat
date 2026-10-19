import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const bundlePath = join(root, "dist/adapters/deepseek-harness/client.js");
const source = await readFile(bundlePath, "utf8");

let loaded;
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Headers,
  Response,
};
sandbox.globalThis = sandbox;
sandbox.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
};

vm.runInNewContext(source, sandbox, {
  filename: bundlePath,
  contextCodeGeneration: { strings: false, wasm: false },
});

assert.ok(loaded, "bundle must call window.__ModuleLoader__.load");
assert.equal(loaded.id, "@memtensor/memos-local-plugin");
assert.equal(typeof loaded.factory, "function");

const react = {
  useEffect() {},
  useMemo(factory) {
    return factory();
  },
  useState(initial) {
    return [initial, () => {}];
  },
};
const jsxRuntime = {
  Fragment: Symbol("Fragment"),
  jsx() {},
  jsxs() {},
};
const requiredExternals = new Map([
  ["react", react],
  ["react/jsx-runtime", jsxRuntime],
]);
const factoryExports = loaded.factory((specifier) => {
  const external = requiredExternals.get(specifier);
  assert.ok(external, `unexpected external import: ${specifier}`);
  return external;
});

assert.deepEqual([...factoryExports.inject], ["slots"]);
assert.equal(typeof factoryExports.apply, "function");

let injectedName;
let callback;
let registration;
const ctx = {
  slots: {
    inject(name, next) {
      injectedName = name;
      callback = next;
    },
    register(definition, component) {
      registration = { definition, component };
      return registration;
    },
  },
};

factoryExports.apply(ctx);
assert.equal(injectedName, "settings.section");
assert.equal(typeof callback, "function");
callback();
assert.equal(registration?.definition?.name, "settings.section");
assert.equal(registration?.definition?.id, "memos-memory");
assert.equal(registration?.definition?.label(), "记忆插件");
assert.equal(registration?.definition?.order, 20);
assert.equal(typeof registration?.component, "function");

const requestStart = source.indexOf("function isRecord");
const requestEnd = source.indexOf("function modelKey");
assert.ok(requestStart >= 0 && requestEnd > requestStart);
const requestSandbox = {
  console,
  setTimeout,
  clearTimeout,
  Headers,
  Response,
};
requestSandbox.globalThis = requestSandbox;
const transportCalls = [];
requestSandbox.__DSH_TRANSPORT__ = {
  async fetch(path, init) {
    transportCalls.push({ path, init });
    return new Response(JSON.stringify({ selection: { mode: "follow" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
};
let globalFetchCalls = 0;
requestSandbox.fetch = async () => {
  globalFetchCalls += 1;
  throw new Error("global fetch must not run when the DSH transport exists");
};

vm.runInNewContext(
  `${source.slice(requestStart, requestEnd)}\nthis.requestJsonForTest = requestJson;`,
  requestSandbox,
  { filename: "requestJson.js" },
);
const snapshot = await requestSandbox.requestJsonForTest("/api/memos/settings");
assert.equal(snapshot.selection.mode, "follow");
assert.equal(globalFetchCalls, 0);
assert.equal(transportCalls.length, 1);
assert.equal(transportCalls[0].path, "/api/memos/settings");
assert.equal(transportCalls[0].init.credentials, "same-origin");
assert.equal(transportCalls[0].init.cache, "no-store");
assert.equal(transportCalls[0].init.headers.get("accept"), "application/json");

const payloadStart = source.indexOf("function historyConfigDraft");
const payloadEnd = source.indexOf("function historyModelGroups");
assert.ok(payloadStart >= 0 && payloadEnd > payloadStart);
const payloadSandbox = {
  console,
  setTimeout,
  clearTimeout,
  Headers,
  Response,
};
payloadSandbox.globalThis = payloadSandbox;
vm.runInNewContext(
  [
    "function historyModelKey(model) {",
    "  return model === undefined ? \"__memory_route__\" : `${model.provider}\\u0000${model.model}`;",
    "}",
    "function clampNumber(value, fallback, min, max) {",
    "  if (!Number.isFinite(value)) return fallback;",
    "  return Math.min(max, Math.max(min, Math.round(value)));",
    "}",
    "const DEFAULT_PEER_PORT = 18802;",
    "const DEFAULT_POLL_INTERVAL_SECONDS = 30;",
    "function historyPeerPort(value) {",
    "  return clampNumber(Number(value), DEFAULT_PEER_PORT, 1024, 65535);",
    "}",
    "function historyPollInterval(value) {",
    "  return clampNumber(Number(value), DEFAULT_POLL_INTERVAL_SECONDS, 15, 3600);",
    "}",
    source.slice(payloadStart, payloadEnd),
    "this.historyConfigDraftForTest = historyConfigDraft;",
    "this.historyDraftAfterStatusRefreshForTest = historyDraftAfterStatusRefresh;",
    "this.historyDraftAfterResponseForTest = historyDraftAfterResponse;",
    "this.buildHistorySavePayloadForTest = buildHistorySavePayload;",
    "this.sameHistoryConfigForTest = sameHistoryConfig;",
  ].join("\n"),
  payloadSandbox,
  { filename: "history-payload.js" },
);

const saved = payloadSandbox.historyConfigDraftForTest({
  config: {
    enabled: true,
    codexRoot: "C:\\\\sessions",
    dshRoot: "D:\\\\sessions",
    recentDays: 7,
    remote: {
      enabled: true,
      url: "https://memory.example.com",
      tokenFile: "C:\\\\secrets\\\\token.json",
      tunnelFile: "C:\\\\secrets\\\\ssh.json",
      sessionFile: " C:\\\\secrets\\\\session.json ",
      nodeId: " nanopi-m4v2 ",
      expectedNodeId: " windows-dsh ",
      lanDiscovery: true,
      peerPort: 18_802,
      pollIntervalSeconds: 30,
      syncEnabled: true,
      pairingKey: "must-not-be-read",
      session: "must-not-be-read",
      hasPairingKey: true,
      hasSession: true,
    },
  },
  status: {
    running: false,
    imported: 0,
    skipped: 0,
    waitingForModel: false,
  },
  mcp: { enabled: false },
  remote: {
    state: "connected",
    route: "lan",
    nodeId: "nanopi-m4v2",
    lastConnectedAt: Date.now(),
    sync: { replicas: { trace: 2, policy: 1 } },
  },
});

assert.equal(saved.remote.nodeId, " nanopi-m4v2 ");
assert.equal(saved.remote.sessionFile, " C:\\\\secrets\\\\session.json ");
assert.equal(saved.remote.pairingKey, undefined);
assert.equal(saved.remote.session, undefined);
assert.equal(saved.remote.hasPairingKey, true);
assert.equal(saved.remote.hasSession, true);
assert.equal(saved.remote.tunnelFile, undefined);
assert.equal(payloadSandbox.sameHistoryConfigForTest(saved, saved), true);

saved.remote.pairingKey = "new-pairing-key";
saved.remote.session = "new-session";
const payload = payloadSandbox.buildHistorySavePayloadForTest(saved);
assert.deepEqual(JSON.parse(JSON.stringify(payload.remote)), {
  enabled: true,
  url: "https://memory.example.com",
  tokenFile: "C:\\\\secrets\\\\token.json",
  sessionFile: "C:\\\\secrets\\\\session.json",
  nodeId: "nanopi-m4v2",
  expectedNodeId: "windows-dsh",
  lanDiscovery: true,
  peerPort: 18_802,
  pollIntervalSeconds: 30,
  syncEnabled: true,
  pairingKey: "new-pairing-key",
  session: "new-session",
});
assert.equal("tunnelFile" in payload.remote, false);
assert.equal("hasPairingKey" in payload.remote, false);
assert.equal("hasSession" in payload.remote, false);

const blankSecrets = payloadSandbox.buildHistorySavePayloadForTest({
  ...saved,
  remote: {
    ...saved.remote,
    pairingKey: "   ",
    session: "",
  },
});
assert.equal("pairingKey" in blankSecrets.remote, false);
assert.equal("session" in blankSecrets.remote, false);

const unsaved = {
  ...saved,
  remote: {
    ...saved.remote,
    nodeId: "unsaved-node",
    pairingKey: "unsaved-secret",
  },
};
assert.equal(
  payloadSandbox.historyDraftAfterStatusRefreshForTest(unsaved, saved, {
    config: payloadSandbox.historyConfigDraftForTest({
      config: {
        enabled: true,
        codexRoot: "C:\\\\sessions",
        dshRoot: "D:\\\\sessions",
        recentDays: 7,
        remote: { enabled: true, url: "https://other.example.com", tokenFile: "" },
      },
      status: {
        running: true,
        imported: 1,
        skipped: 0,
        waitingForModel: false,
      },
      mcp: { enabled: false },
    }).config,
    status: {
      running: true,
      imported: 1,
      skipped: 0,
      waitingForModel: false,
    },
    mcp: { enabled: false },
  }),
  unsaved,
);
assert.equal(
  payloadSandbox.historyDraftAfterResponseForTest(unsaved, saved, {
    config: payloadSandbox.historyConfigDraftForTest({
      config: {
        enabled: true,
        codexRoot: "C:\\\\sessions",
        dshRoot: "D:\\\\sessions",
        recentDays: 7,
        remote: { enabled: true, url: "https://other.example.com", tokenFile: "" },
      },
      status: {
        running: true,
        imported: 1,
        skipped: 0,
        waitingForModel: false,
      },
      mcp: { enabled: false },
    }).config,
    status: {
      running: true,
      imported: 1,
      skipped: 0,
      waitingForModel: false,
    },
    mcp: { enabled: false },
  }),
  unsaved,
);

console.log("client registration, transport, and history payload harness: pass");
