import { Fragment, h } from "preact";
import { beforeAll, describe, expect, it } from "vitest";

import type {
  DshHistoryConfig,
} from "../../../viewer/src/components/DshHistorySettings";

let buildHistorySavePayload: typeof import("../../../viewer/src/components/DshHistorySettings").buildHistorySavePayload;
let configDraft: typeof import("../../../viewer/src/components/DshHistorySettings").configDraft;
let sameConfig: typeof import("../../../viewer/src/components/DshHistorySettings").sameConfig;

beforeAll(async () => {
  // Vitest uses the repo's classic JSX transform for TSX modules; the
  // component tree depends on a global React binding only in tests.
  (globalThis as { React?: unknown }).React = {
    createElement: h,
    Fragment,
  };
  const mod = await import(
    "../../../viewer/src/components/DshHistorySettings"
  );
  buildHistorySavePayload = mod.buildHistorySavePayload;
  configDraft = mod.configDraft;
  sameConfig = mod.sameConfig;
});

function config(
  remote: Partial<DshHistoryConfig["remote"]> = {},
): DshHistoryConfig {
  return {
    enabled: true,
    codexRoot: "C:\\Users\\saya\\.codex\\sessions",
    dshRoot: "C:\\Users\\saya\\.dsh\\sessions",
    recentDays: 7,
    remote: {
      enabled: true,
      url: "https://memory.example.com/desktop/api/memory-peer",
      tokenFile: "",
      ...remote,
    },
  };
}

describe("DSH history peer settings", () => {
  it("applies peer defaults without echoing secret values", () => {
    const draft = configDraft(
      config({
        pairingKey: "must-not-be-echoed",
        session: "must-not-be-echoed-either",
        hasPairingKey: true,
        hasSession: true,
      }),
    );

    expect(draft.enabled).toBe(true);
    expect(draft.remote).toMatchObject({
      lanDiscovery: true,
      peerPort: 18_802,
      pollIntervalSeconds: 30,
      hasPairingKey: true,
      hasSession: true,
    });
    expect(draft.remote).not.toHaveProperty("syncEnabled");
    expect(draft.remote).not.toHaveProperty("pairingKey");
    expect(draft.remote).not.toHaveProperty("session");
  });

  it("submits only newly entered secrets and never response-only flags", () => {
    const draft = configDraft(
      config({
        hasPairingKey: true,
        hasSession: true,
        nodeId: " nanopi-m4v2 ",
        expectedNodeId: " windows-dsh ",
        syncEnabled: true,
      }),
    );
    draft.remote.pairingKey = " new-pairing-key ";
    draft.remote.session = "new-session";
    const payload = buildHistorySavePayload(draft);

    expect(payload.remote).toMatchObject({
      enabled: true,
      url: "https://memory.example.com/desktop/api/memory-peer",
      nodeId: "nanopi-m4v2",
      expectedNodeId: "windows-dsh",
      lanDiscovery: true,
      peerPort: 18_802,
      pollIntervalSeconds: 30,
      syncEnabled: true,
      pairingKey: " new-pairing-key ",
      session: "new-session",
    });
    expect(payload.remote).not.toHaveProperty("hasPairingKey");
    expect(payload.remote).not.toHaveProperty("hasSession");
    expect(payload.remote).not.toHaveProperty("tunnelFile");
  });

  it("omits blank secrets so saving unrelated fields keeps stored credentials", () => {
    const draft = configDraft(
      config({
        hasPairingKey: true,
        hasSession: true,
        pairingKey: "   ",
        session: "",
      }),
    );
    const payload = buildHistorySavePayload(draft);

    expect(payload.remote).not.toHaveProperty("pairingKey");
    expect(payload.remote).not.toHaveProperty("session");
  });

  it("treats omitted new peer defaults as unchanged", () => {
    expect(
      sameConfig(
        config(),
        configDraft(
          config({
            lanDiscovery: true,
            peerPort: 18_802,
            pollIntervalSeconds: 30,
          }),
        ),
      ),
    ).toBe(true);
  });

  it("detects changed peer controls and unsaved secrets as dirty", () => {
    const saved = config();
    expect(
      sameConfig(config({ lanDiscovery: false }), saved),
    ).toBe(false);
    expect(sameConfig(config({ peerPort: 18_803 }), saved)).toBe(false);
    expect(sameConfig(config({ pollIntervalSeconds: 60 }), saved)).toBe(false);
    expect(sameConfig(config({ syncEnabled: true }), saved)).toBe(false);
    expect(sameConfig(config({ pairingKey: "pending" }), saved)).toBe(false);
  });

  it("preserves the legacy token file while dropping tunnelFile on save", () => {
    const draft = configDraft(
      config({
        tokenFile: "C:\\secrets\\legacy-token.json",
        tunnelFile: "C:\\secrets\\legacy-ssh.json",
      }),
    );
    expect(draft.remote.tunnelFile).toBe("C:\\secrets\\legacy-ssh.json");
    expect(buildHistorySavePayload(draft).remote).not.toHaveProperty(
      "tunnelFile",
    );
  });
});
