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

console.log("client registration and DSH transport harness: pass");
