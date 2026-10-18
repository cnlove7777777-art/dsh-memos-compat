/**
 * Codex/DSH history bridge settings.
 *
 * The Viewer edits only the durable history configuration. A separate action
 * starts one bounded run, and status refresh never persists unsaved edits.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { api, ApiError } from "../api/client";
import { Icon } from "./Icon";

export interface DshHistoryBackgroundModel {
  provider: string;
  model: string;
}

export interface DshHistoryRemoteConfig {
  enabled: boolean;
  url: string;
  /** Legacy credential file retained for advanced compatibility. */
  tokenFile: string;
  /** Legacy transport setting; preserved from responses but never submitted. */
  tunnelFile?: string;
  /** Write-only pairing secret. It is cleared after a successful save. */
  pairingKey?: string;
  /** Write-only server session secret. It is cleared after a successful save. */
  session?: string;
  sessionFile?: string;
  nodeId?: string;
  expectedNodeId?: string;
  lanDiscovery?: boolean;
  peerPort?: number;
  pollIntervalSeconds?: number;
  syncEnabled?: boolean;
  /** Response-only markers. They are never sent back to the server. */
  hasPairingKey?: boolean;
  hasSession?: boolean;
}

export interface DshHistoryConfig {
  enabled: boolean;
  codexRoot: string;
  dshRoot: string;
  recentDays: number;
  backgroundModel?: DshHistoryBackgroundModel;
  remote: DshHistoryRemoteConfig;
}

export interface DshHistoryStatus {
  running: boolean;
  lastRunAt?: number;
  imported: number;
  skipped: number;
  waitingForModel: boolean;
  lastError?: string;
}

export interface DshHistoryMcp {
  url?: string;
  enabled: boolean;
}

export interface DshHistoryRemoteStatus {
  state: string;
  route?: "lan" | "wan" | "offline" | (string & {});
  url?: string;
  nodeId?: string;
  lastConnectedAt?: number;
  lastError?: string;
  sync?: Record<string, unknown>;
}

export interface DshHistorySnapshot {
  config: DshHistoryConfig;
  status: DshHistoryStatus;
  mcp: DshHistoryMcp;
  remote?: DshHistoryRemoteStatus;
}

export interface DshHistoryModelOption {
  provider: string;
  providerName?: string;
  model: string;
  modelName?: string;
}

const MEMORY_ROUTE_VALUE = "__memory_route__";
const DEFAULT_PEER_PORT = 18_802;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;

export function DshHistorySettings({
  models,
}: {
  models: DshHistoryModelOption[];
}) {
  const [snapshot, setSnapshot] = useState<DshHistorySnapshot | null>(null);
  const [draft, setDraft] = useState<DshHistoryConfig | null>(null);
  const [capability, setCapability] = useState<
    "loading" | "available" | "unavailable" | "error"
  >("loading");
  const [capabilityError, setCapabilityError] = useState("");
  const [action, setAction] = useState<
    "save" | "run" | "refresh" | "connect" | null
  >(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .get<DshHistorySnapshot>("/api/v1/dsh/history", { signal: ctrl.signal })
      .then((next) => {
        setSnapshot(next);
        setDraft(configDraft(next.config));
        setCapability("available");
      })
      .catch((error) => {
        if (ctrl.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          setCapability("unavailable");
          return;
        }
        setCapability("error");
        setCapabilityError(errorMessage(error));
      });
    return () => ctrl.abort();
  }, []);

  const groups = useMemo(() => groupModels(models), [models]);
  const modelKeys = useMemo(
    () => new Set(models.map((item) => modelKey(item.provider, item.model))),
    [models],
  );
  const selectedModelKey = modelKeyOf(draft?.backgroundModel);
  const selectedModelAvailable =
    selectedModelKey === MEMORY_ROUTE_VALUE || modelKeys.has(selectedModelKey);
  const savedModelKey = modelKeyOf(snapshot?.config.backgroundModel);
  const savedModelAvailable =
    savedModelKey === MEMORY_ROUTE_VALUE || modelKeys.has(savedModelKey);
  const selectModelValue =
    draft?.backgroundModel === undefined || selectedModelAvailable
      ? selectedModelKey
      : MEMORY_ROUTE_VALUE;
  const busy = action !== null;
  const dirty =
    snapshot !== null &&
    draft !== null &&
    !sameConfig(draft, snapshot.config);
  const remoteStatus = snapshot?.remote;
  const remoteStatusText = remoteStateLabel(remoteStatus?.state);
  const remoteRouteText = remoteRouteLabel(remoteStatus?.route);
  const syncText = syncStatusText(remoteStatus?.sync);
  const pairingConfigured =
    snapshot?.config.remote.hasPairingKey === true ||
    draft?.remote.hasPairingKey === true;
  const sessionConfigured =
    snapshot?.config.remote.hasSession === true ||
    draft?.remote.hasSession === true;

  const patch = (next: Partial<DshHistoryConfig>) => {
    setDraft((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            ...next,
            remote: next.remote ?? previous.remote,
          },
    );
    setNotice(null);
  };

  const patchRemote = (next: Partial<DshHistoryConfig["remote"]>) => {
    setDraft((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            remote: { ...previous.remote, ...next },
          },
    );
    setNotice(null);
  };

  const save = async () => {
    if (draft === null || busy || !selectedModelAvailable) return;
    setAction("save");
    setNotice(null);
    try {
      const next = await api.put<DshHistorySnapshot>(
        "/api/v1/dsh/history",
        buildHistorySavePayload(draft),
      );
      setSnapshot(next);
      setDraft(configDraft(next.config));
      setCapability("available");
      setNotice({
        kind: "ok",
        text: "历史互通设置已保存；启用时会自动开始整理。",
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setCapability("unavailable");
      } else {
        setNotice({ kind: "error", text: `保存失败：${errorMessage(error)}` });
      }
    } finally {
      setAction(null);
    }
  };

  const run = async () => {
    if (busy) return;
    setAction("run");
    setNotice(null);
    try {
      const next = await api.post<DshHistorySnapshot>(
        "/api/v1/dsh/history-run",
        undefined,
      );
      setSnapshot(next);
      setDraft((previous) =>
        previous === null || dirty ? previous : configDraft(next.config),
      );
      setCapability("available");
      setNotice({ kind: "ok", text: "已提交历史整理任务。" });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setCapability("unavailable");
      } else {
        setNotice({ kind: "error", text: `运行失败：${errorMessage(error)}` });
      }
    } finally {
      setAction(null);
    }
  };

  const refresh = async () => {
    if (busy) return;
    const snapshotAtStart = snapshot;
    setAction("refresh");
    setNotice(null);
    try {
      const next = await api.get<DshHistorySnapshot>("/api/v1/dsh/history");
      setSnapshot(next);
      setDraft((previous) =>
        previous === null ||
        snapshotAtStart === null ||
        !sameConfig(previous, snapshotAtStart.config)
          ? previous
          : configDraft(next.config),
      );
      setCapability("available");
      setNotice({ kind: "ok", text: "运行状态已刷新。" });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setCapability("unavailable");
      } else {
        setNotice({ kind: "error", text: `刷新状态失败：${errorMessage(error)}` });
      }
    } finally {
      setAction(null);
    }
  };

  const connect = async () => {
    if (busy) return;
    if (dirty) {
      setNotice({
        kind: "error",
        text: "有未保存的改动，请先保存后再测试已保存配置。",
      });
      return;
    }
    if (snapshot?.config.remote.enabled !== true) {
      setNotice({ kind: "error", text: "请先启用并保存远端连接配置。" });
      return;
    }
    setAction("connect");
    setNotice(null);
    const snapshotAtStart = snapshot;
    try {
      const next = await api.post<DshHistorySnapshot>(
        "/api/v1/dsh/history/connect",
        {},
      );
      setSnapshot(next);
      setDraft((previous) =>
        previous === null ||
        snapshotAtStart === null ||
        !sameConfig(previous, snapshotAtStart.config)
          ? previous
          : configDraft(next.config),
      );
      setCapability("available");
      const failed = !next.remote || isRemoteFailure(next.remote);
      setNotice({
        kind: failed ? "error" : "ok",
        text: remoteConnectionNotice(next.remote),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setNotice({
          kind: "error",
          text: "当前服务端未提供“发现并测试连接”接口。",
        });
      } else {
        setNotice({ kind: "error", text: `连接测试失败：${errorMessage(error)}` });
      }
    } finally {
      setAction(null);
    }
  };

  if (capability === "loading") {
    return (
      <section class="card card--flat">
        <div class="hstack">
          <Icon name="loader-2" size={16} class="spin" />
          <span class="muted" style="font-size:var(--fs-sm)">
            正在检查历史互通能力…
          </span>
        </div>
      </section>
    );
  }

  if (capability === "unavailable") return null;

  if (capability === "error") {
    return (
      <section class="card" role="alert" style="border-color:var(--danger)">
        <div class="card__header">
          <div>
            <h3 class="card__title">无法读取历史互通设置</h3>
            <p class="card__subtitle" style="margin-bottom:0">
              {capabilityError}
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (snapshot === null || draft === null) return null;

  return (
    <section class="card" style="border-left:3px solid var(--accent)">
      <div class="card__header">
        <div class="hstack" style="align-items:flex-start">
          <span
            aria-hidden="true"
            style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-md);background:var(--accent-soft);color:var(--accent);flex-shrink:0"
          >
            <Icon name="history" size={16} />
          </span>
          <div>
            <div class="hstack" style="gap:var(--sp-2);flex-wrap:wrap">
              <h3 class="card__title" style="margin:0">
                Codex 与 DSH 历史互通
              </h3>
              <span
                class={`pill ${draft.enabled ? "pill--active" : "pill--draft"}`}
              >
                {draft.enabled ? "已启用" : "未启用"}
              </span>
              {snapshot.status.running && (
                <span class="pill pill--running">运行中</span>
              )}
              {snapshot.status.waitingForModel && (
                <span class="pill pill--candidate">等待模型</span>
              )}
            </div>
            <p class="card__subtitle" style="margin:4px 0 0">
              只读取本地会话 JSONL，不执行其中的内容；最近窗口限制为 1–30 天。
            </p>
          </div>
        </div>
        <span class="muted" style="font-size:var(--fs-xs)">
          凭据只写不回显
        </span>
      </div>

      <label class="hstack" style="gap:var(--sp-2);align-items:flex-start;cursor:pointer">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={busy}
          onChange={(event) =>
            patch({ enabled: (event.target as HTMLInputElement).checked })
          }
          style="margin-top:3px"
        />
        <span>
          <span style="display:block;font-size:var(--fs-sm);font-weight:var(--fw-med)">
            启用历史互通
          </span>
          <span class="muted" style="display:block;font-size:var(--fs-xs);line-height:1.6">
            保存启用后会自动整理，每分钟检查一次；也可手动运行。
          </span>
        </span>
      </label>

      <div
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--sp-4);margin-top:var(--sp-4)"
      >
        <Field label="Codex 历史根目录">
          <input
            class="input"
            value={draft.codexRoot}
            disabled={busy}
            spellcheck={false}
            placeholder="C:\\Users\\name\\.codex\\sessions"
            onInput={(event) =>
              patch({ codexRoot: (event.target as HTMLInputElement).value })
            }
          />
        </Field>
        <Field label="DSH 历史根目录">
          <input
            class="input"
            value={draft.dshRoot}
            disabled={busy}
            spellcheck={false}
            placeholder="C:\\Users\\name\\.dsh\\sessions"
            onInput={(event) =>
              patch({ dshRoot: (event.target as HTMLInputElement).value })
            }
          />
        </Field>
        <Field label="最近天数">
          <input
            class="input"
            type="number"
            min={1}
            max={30}
            value={draft.recentDays}
            disabled={busy}
            onInput={(event) =>
              patch({
                recentDays: clampRecentDays(
                  Number((event.target as HTMLInputElement).value) || 1,
                ),
              })
            }
          />
        </Field>
        <Field label="后台整理模型">
          <select
            class="select"
            value={selectModelValue}
            disabled={busy}
            onInput={(event) =>
              patch({
                backgroundModel: parseModelKey(
                  (event.target as HTMLSelectElement).value,
                ),
              })
            }
          >
            <option value={MEMORY_ROUTE_VALUE}>
              使用记忆固定模型（跟随模式下等待）
            </option>
            {!selectedModelAvailable && (
              <option value={selectedModelKey}>
                当前已保存的模型不在本次目录中
              </option>
            )}
            {groups.map((group) => (
              <optgroup key={group.provider} label={group.label}>
                {group.models.map((item) => {
                  const key = modelKey(item.provider, item.model);
                  return (
                    <option key={key} value={key}>
                      {item.modelName?.trim() || item.model} · {item.model}
                    </option>
                  );
                })}
              </optgroup>
            ))}
          </select>
        </Field>
      </div>

      <div
        style="margin-top:var(--sp-4);padding-top:var(--sp-4);border-top:1px solid var(--border)"
      >
        <label class="hstack" style="gap:var(--sp-2);align-items:flex-start;cursor:pointer">
          <input
            type="checkbox"
            checked={draft.remote.enabled}
            disabled={busy}
            onChange={(event) =>
              patchRemote({
                enabled: (event.target as HTMLInputElement).checked,
              })
            }
            style="margin-top:3px"
          />
          <span>
            <span style="display:block;font-size:var(--fs-sm);font-weight:var(--fw-med)">
              MemOS 联网与设备互联
            </span>
            <span class="muted" style="display:block;font-size:var(--fs-xs);line-height:1.6">
              通过 HTTPS 或已配对 LAN 发现连接另一台设备；只同步记忆摘要，不上传原始会话。
            </span>
          </span>
        </label>

        {(remoteStatus || draft.remote.enabled) && (
          <div
            style="margin-top:var(--sp-3);padding:var(--sp-3);border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg-canvas)"
          >
            <div
              class="hstack"
              style="justify-content:space-between;gap:var(--sp-2);flex-wrap:wrap"
            >
              <div class="hstack" style="gap:var(--sp-2);flex-wrap:wrap">
                <span
                  class={`pill ${remoteStatePill(remoteStatus?.state)}`}
                >
                  {remoteStatusText}
                </span>
                {remoteRouteText && (
                  <span class="pill pill--subtle">{remoteRouteText}</span>
                )}
                {syncText && <span class="pill pill--subtle">{syncText}</span>}
              </div>
              <span class="muted" style="font-size:var(--fs-xs)">
                上次连接 {formatConnectedAt(remoteStatus?.lastConnectedAt)}
              </span>
            </div>
            {(remoteStatus?.nodeId || remoteStatus?.url) && (
              <div
                style="margin-top:6px;font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--fg-muted);overflow-wrap:anywhere"
              >
                {[remoteStatus.nodeId, remoteStatus.url]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            )}
            {remoteStatus?.lastError && (
              <div
                role="status"
                style="margin-top:6px;font-size:var(--fs-xs);color:var(--danger);overflow-wrap:anywhere"
              >
                {remoteStatus.lastError}
              </div>
            )}
          </div>
        )}

        <div
          style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--sp-4);margin-top:var(--sp-4)"
        >
          <Field label="远程 HTTPS 地址">
            <input
              class="input"
              type="url"
              value={draft.remote.url}
              disabled={busy}
              spellcheck={false}
              placeholder="https://memory.example.com/desktop/api/memory-peer"
              onInput={(event) =>
                patchRemote({ url: (event.target as HTMLInputElement).value })
              }
            />
          </Field>
          <Field label="配对 key（写入后不回显）">
            <input
              class="input"
              type="password"
              autocomplete="new-password"
              value={draft.remote.pairingKey ?? ""}
              disabled={busy}
              spellcheck={false}
              placeholder={
                pairingConfigured
                  ? "已配置；留空保持原值"
                  : "输入这台设备的配对 key"
              }
              onInput={(event) =>
                patchRemote({
                  pairingKey: (event.target as HTMLInputElement).value,
                })
              }
            />
          </Field>
          <Field label="服务器 session（写入后不回显）">
            <input
              class="input"
              type="password"
              autocomplete="new-password"
              value={draft.remote.session ?? ""}
              disabled={busy}
              spellcheck={false}
              placeholder={
                sessionConfigured
                  ? "已配置；留空保持原值"
                  : "可选：服务器分配的 session"
              }
              onInput={(event) =>
                patchRemote({
                  session: (event.target as HTMLInputElement).value,
                })
              }
            />
          </Field>
          <Field label="本机设备标识">
            <input
              class="input"
              value={draft.remote.nodeId ?? ""}
              disabled={busy}
              spellcheck={false}
              placeholder="例如 nanopi-m4v2"
              onInput={(event) =>
                patchRemote({
                  nodeId: (event.target as HTMLInputElement).value,
                })
              }
            />
          </Field>
          <Field label="期望对端 ID">
            <input
              class="input"
              value={draft.remote.expectedNodeId ?? ""}
              disabled={busy}
              spellcheck={false}
              placeholder="防止连错设备，可留空"
              onInput={(event) =>
                patchRemote({
                  expectedNodeId: (event.target as HTMLInputElement).value,
                })
              }
            />
          </Field>
          <Field label="发现间隔（秒）">
            <input
              class="input"
              type="number"
              min={1}
              max={3600}
              value={
                draft.remote.pollIntervalSeconds ??
                DEFAULT_POLL_INTERVAL_SECONDS
              }
              disabled={busy}
              onInput={(event) =>
                patchRemote({
                  pollIntervalSeconds: clampNumber(
                    Number((event.target as HTMLInputElement).value),
                    DEFAULT_POLL_INTERVAL_SECONDS,
                    1,
                    3600,
                  ),
                })
              }
            />
          </Field>
          <Field label="服务端口">
            <input
              class="input"
              type="number"
              min={1}
              max={65535}
              value={draft.remote.peerPort ?? DEFAULT_PEER_PORT}
              disabled={busy}
              onInput={(event) =>
                patchRemote({
                  peerPort: clampNumber(
                    Number((event.target as HTMLInputElement).value),
                    DEFAULT_PEER_PORT,
                    1,
                    65_535,
                  ),
                })
              }
            />
          </Field>
        </div>
        <div
          class="hstack"
          style="gap:var(--sp-4);flex-wrap:wrap;margin-top:var(--sp-3)"
        >
          <ToggleRow
            label="LAN 自动发现"
            checked={draft.remote.lanDiscovery !== false}
            disabled={busy}
            onChange={(checked) => patchRemote({ lanDiscovery: checked })}
          />
          <ToggleRow
            label="自动同步记忆"
            checked={draft.remote.syncEnabled === true}
            disabled={busy}
            onChange={(checked) => patchRemote({ syncEnabled: checked })}
          />
        </div>
        <div
          class="muted"
          style="margin-top:var(--sp-2);font-size:var(--fs-xs);line-height:1.6"
        >
          配对 key 与 session 只写入私有 sidecar，保存成功后清空输入且不会回显。此页不再自动启动 SSH，保存时也不会保留旧隧道字段。
        </div>
        <details style="margin-top:var(--sp-3)">
          <summary
            style="cursor:pointer;font-size:var(--fs-xs);color:var(--fg-muted)"
          >
            高级兼容
          </summary>
          <div
            style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--sp-4);margin-top:var(--sp-3)"
          >
            <Field label="旧版 Token 文件（JSON，可选）">
              <input
                class="input"
                value={draft.remote.tokenFile}
                disabled={busy}
                spellcheck={false}
                placeholder="C:\\secrets\\memos-token.json"
                onInput={(event) =>
                  patchRemote({
                    tokenFile: (event.target as HTMLInputElement).value,
                  })
                }
              />
            </Field>
            <Field label="服务器 session 文件（可选）">
              <input
                class="input"
                value={draft.remote.sessionFile ?? ""}
                disabled={busy}
                spellcheck={false}
                placeholder="C:\\secrets\\memory-session.json"
                onInput={(event) =>
                  patchRemote({
                    sessionFile: (event.target as HTMLInputElement).value,
                  })
                }
              />
            </Field>
          </div>
        </details>
      </div>

      <div
        style="margin-top:var(--sp-4);padding:var(--sp-3);border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg-canvas)"
      >
        <div class="hstack" style="justify-content:space-between;gap:var(--sp-2);flex-wrap:wrap">
          <span style="font-size:var(--fs-sm);font-weight:var(--fw-med)">
            MCP 只读状态
          </span>
          <span class={`pill ${snapshot.mcp.enabled ? "pill--active" : "pill--subtle"}`}>
            {snapshot.mcp.enabled ? "已启用" : "未启用"}
          </span>
        </div>
        <div
          style="margin-top:4px;font-family:var(--font-mono);font-size:var(--fs-xs);overflow-wrap:anywhere"
        >
          {snapshot.mcp.url || "未提供地址"}
        </div>
        <div class="muted" style="font-size:var(--fs-xs);margin-top:4px">
          MCP 状态为只读，不提供凭据输入或编辑。
        </div>
      </div>

      <div
        class="hstack"
        style="gap:var(--sp-2);flex-wrap:wrap;margin-top:var(--sp-4)"
      >
        <span class={`pill ${snapshot.status.running ? "pill--running" : "pill--subtle"}`}>
          {snapshot.status.running ? "正在运行" : "当前空闲"}
        </span>
        <span class="pill pill--info">已导入 {snapshot.status.imported}</span>
        <span class="pill pill--subtle">已跳过 {snapshot.status.skipped}</span>
        <span class="pill pill--subtle">
          上次运行 {formatTimestamp(snapshot.status.lastRunAt)}
        </span>
        {snapshot.status.waitingForModel && (
          <span class="pill pill--candidate">等待记忆模型</span>
        )}
      </div>
      {snapshot.status.lastError && (
        <div
          role="status"
          style="margin-top:var(--sp-2);font-size:var(--fs-xs);color:var(--warning)"
        >
          {snapshot.status.lastError}
        </div>
      )}

      {notice && (
        <div
          role="status"
          class="hstack"
          style={`margin-top:var(--sp-3);padding:var(--sp-2) var(--sp-3);border-radius:var(--radius-sm);background:${
            notice.kind === "ok" ? "var(--success-soft)" : "var(--danger-soft)"
          };color:${
            notice.kind === "ok" ? "var(--success)" : "var(--danger)"
          };font-size:var(--fs-xs)`}
        >
          <Icon
            name={notice.kind === "ok" ? "check" : "circle-alert"}
            size={14}
          />
          <span>{notice.text}</span>
        </div>
      )}

      <div
        class="hstack"
        style="gap:var(--sp-2);flex-wrap:wrap;margin-top:var(--sp-4)"
      >
        <button class="btn btn--sm" onClick={() => void refresh()} disabled={busy}>
          <Icon
            name={action === "refresh" ? "loader-2" : "refresh-cw"}
            size={14}
            class={action === "refresh" ? "spin" : ""}
          />
          {action === "refresh" ? "刷新中…" : "刷新状态"}
        </button>
        <button
          class="btn btn--sm"
          onClick={() => void connect()}
          disabled={busy}
          title={
            dirty
              ? "请先保存未提交的改动，再测试已保存配置"
              : "使用已保存的配置发现并测试连接"
          }
        >
          <Icon
            name={action === "connect" ? "loader-2" : "plug"}
            size={14}
            class={action === "connect" ? "spin" : ""}
          />
          {action === "connect" ? "测试中…" : "发现并测试连接"}
        </button>
        {dirty && (
          <span
            class="muted"
            style="font-size:var(--fs-xs);color:var(--warning)"
          >
            有未保存改动；测试前请先保存
          </span>
        )}
        <button
          class="btn btn--sm"
          onClick={() => void run()}
          disabled={busy || !snapshot.config.enabled || !savedModelAvailable}
        >
          <Icon
            name={action === "run" ? "loader-2" : "play"}
            size={14}
            class={action === "run" ? "spin" : ""}
          />
          {action === "run" ? "运行中…" : "运行一次"}
        </button>
        <button
          class="btn btn--primary btn--sm"
          onClick={() => void save()}
          disabled={busy || !dirty || !selectedModelAvailable}
        >
          <Icon
            name={action === "save" ? "loader-2" : "check"}
            size={14}
            class={action === "save" ? "spin" : ""}
          />
          {action === "save" ? "保存中…" : "保存"}
        </button>
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: preact.ComponentChildren;
}) {
  return (
    <label style="display:flex;flex-direction:column;gap:6px">
      <span
        style="font-size:var(--fs-xs);color:var(--fg-muted);font-weight:var(--fw-med)"
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function ToggleRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div
      class="hstack"
      style="gap:var(--sp-2);align-items:center;cursor:pointer;font-size:var(--fs-sm)"
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        style={`
          position:relative;width:40px;height:22px;border-radius:999px;
          background:${checked ? "var(--accent)" : "var(--border-strong)"};
          border:none;cursor:${disabled ? "not-allowed" : "pointer"};
          transition:background var(--dur-xs);flex-shrink:0;
          opacity:${disabled ? 0.6 : 1}
        `}
      >
        <span
          aria-hidden="true"
          style={`
            position:absolute;left:${checked ? "20px" : "2px"};top:2px;
            width:18px;height:18px;border-radius:999px;background:#fff;
            transition:left var(--dur-xs) var(--ease-out);
            box-shadow:0 1px 3px rgba(0,0,0,0.25)
          `}
        />
      </button>
      <span>{label}</span>
    </div>
  );
}

export function configDraft(config: DshHistoryConfig): DshHistoryConfig {
  return {
    enabled: config.enabled,
    codexRoot: config.codexRoot,
    dshRoot: config.dshRoot,
    recentDays: config.recentDays,
    ...(config.backgroundModel === undefined
      ? {}
      : { backgroundModel: config.backgroundModel }),
    remote: remoteConfigDraft(config.remote),
  };
}

function remoteConfigDraft(remote: DshHistoryRemoteConfig): DshHistoryRemoteConfig {
  const hasPairingKey = remote.hasPairingKey === true;
  const hasSession = remote.hasSession === true;
  return {
    enabled: remote.enabled,
    url: remote.url,
    tokenFile: remote.tokenFile,
    ...(remote.tunnelFile === undefined ? {} : { tunnelFile: remote.tunnelFile }),
    ...(remote.sessionFile === undefined
      ? {}
      : { sessionFile: remote.sessionFile }),
    ...(remote.nodeId === undefined ? {} : { nodeId: remote.nodeId }),
    ...(remote.expectedNodeId === undefined
      ? {}
      : { expectedNodeId: remote.expectedNodeId }),
    lanDiscovery: remote.lanDiscovery !== false,
    peerPort: remote.peerPort ?? DEFAULT_PEER_PORT,
    pollIntervalSeconds:
      remote.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
    ...(remote.syncEnabled === undefined
      ? {}
      : { syncEnabled: remote.syncEnabled }),
    // Secrets are write-only in the UI and are always cleared on refresh/save.
    ...(hasPairingKey ? { hasPairingKey: true } : {}),
    ...(hasSession ? { hasSession: true } : {}),
  };
}

export function buildHistorySavePayload(
  config: DshHistoryConfig,
): DshHistoryConfig {
  const remote: DshHistoryRemoteConfig = {
    enabled: config.remote.enabled,
    url: config.remote.url,
    tokenFile: config.remote.tokenFile,
    ...(config.remote.sessionFile?.trim()
      ? { sessionFile: config.remote.sessionFile.trim() }
      : {}),
    ...(config.remote.nodeId?.trim()
      ? { nodeId: config.remote.nodeId.trim() }
      : {}),
    ...(config.remote.expectedNodeId?.trim()
      ? { expectedNodeId: config.remote.expectedNodeId.trim() }
      : {}),
    lanDiscovery: config.remote.lanDiscovery !== false,
    peerPort: config.remote.peerPort ?? DEFAULT_PEER_PORT,
    pollIntervalSeconds:
      config.remote.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
    ...(config.remote.syncEnabled === undefined
      ? {}
      : { syncEnabled: config.remote.syncEnabled }),
    ...(config.remote.pairingKey?.trim()
      ? { pairingKey: config.remote.pairingKey }
      : {}),
    ...(config.remote.session?.trim()
      ? { session: config.remote.session }
      : {}),
  };
  return {
    enabled: config.enabled,
    codexRoot: config.codexRoot,
    dshRoot: config.dshRoot,
    recentDays: config.recentDays,
    ...(config.backgroundModel === undefined
      ? {}
      : { backgroundModel: config.backgroundModel }),
    remote,
  };
}

export function sameConfig(
  left: DshHistoryConfig,
  right: DshHistoryConfig,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.codexRoot === right.codexRoot &&
    left.dshRoot === right.dshRoot &&
    left.recentDays === right.recentDays &&
    modelKeyOf(left.backgroundModel) === modelKeyOf(right.backgroundModel) &&
    left.remote.enabled === right.remote.enabled &&
    left.remote.url === right.remote.url &&
    left.remote.tokenFile === right.remote.tokenFile &&
    (left.remote.tunnelFile ?? "") === (right.remote.tunnelFile ?? "") &&
    (left.remote.sessionFile ?? "") === (right.remote.sessionFile ?? "") &&
    (left.remote.nodeId ?? "") === (right.remote.nodeId ?? "") &&
    (left.remote.expectedNodeId ?? "") ===
      (right.remote.expectedNodeId ?? "") &&
    (left.remote.lanDiscovery !== false) ===
      (right.remote.lanDiscovery !== false) &&
    (left.remote.peerPort ?? DEFAULT_PEER_PORT) ===
      (right.remote.peerPort ?? DEFAULT_PEER_PORT) &&
    (left.remote.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) ===
      (right.remote.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) &&
    left.remote.syncEnabled === right.remote.syncEnabled &&
    (left.remote.pairingKey ?? "") === (right.remote.pairingKey ?? "") &&
    (left.remote.session ?? "") === (right.remote.session ?? "")
  );
}

function groupModels(
  models: DshHistoryModelOption[],
): Array<{ provider: string; label: string; models: DshHistoryModelOption[] }> {
  const groups = new Map<
    string,
    { label: string; models: DshHistoryModelOption[] }
  >();
  for (const item of models) {
    const label = item.providerName?.trim() || item.provider;
    const group = groups.get(item.provider) ?? { label, models: [] };
    group.models.push(item);
    groups.set(item.provider, group);
  }
  return [...groups.entries()]
    .sort((a, b) => a[1].label.localeCompare(b[1].label))
    .map(([provider, group]) => ({
      provider,
      label: group.label,
      models: group.models.sort((a, b) =>
        (a.modelName?.trim() || a.model).localeCompare(
          b.modelName?.trim() || b.model,
        ),
      ),
    }));
}

function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function modelKeyOf(model: DshHistoryBackgroundModel | undefined): string {
  return model === undefined
    ? MEMORY_ROUTE_VALUE
    : modelKey(model.provider, model.model);
}

function parseModelKey(value: string): DshHistoryBackgroundModel | undefined {
  if (value === MEMORY_ROUTE_VALUE) return undefined;
  const separator = value.indexOf("\u0000");
  if (separator <= 0) return undefined;
  const provider = value.slice(0, separator);
  const model = value.slice(separator + 1);
  return provider && model ? { provider, model } : undefined;
}

function clampRecentDays(value: number): number {
  return Math.min(30, Math.max(1, Math.round(value)));
}

function clampNumber(
  value: number,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatTimestamp(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return "尚未运行";
  }
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatConnectedAt(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return "尚未连接";
  }
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function remoteStateLabel(state: string | undefined): string {
  switch (state?.toLowerCase()) {
    case "connected":
    case "online":
    case "ready":
      return "已连接";
    case "connecting":
    case "discovering":
    case "polling":
      return "正在连接";
    case "offline":
    case "disconnected":
      return "未连接";
    case "error":
    case "failed":
      return "连接失败";
    case "disabled":
      return "未启用";
    default:
      return state?.trim() || "尚未测试";
  }
}

function remoteStatePill(state: string | undefined): string {
  switch (state?.toLowerCase()) {
    case "connected":
    case "online":
    case "ready":
      return "pill--active";
    case "connecting":
    case "discovering":
    case "polling":
      return "pill--running";
    case "error":
    case "failed":
      return "pill--failed";
    case "offline":
    case "disconnected":
      return "pill--candidate";
    default:
      return "pill--subtle";
  }
}

function remoteRouteLabel(route: string | undefined): string {
  switch (route?.toLowerCase()) {
    case "lan":
      return "局域网直连";
    case "wan":
      return "公网 HTTPS";
    case "offline":
      return "离线";
    default:
      return route?.trim() || "";
  }
}

function syncStatusText(sync: Record<string, unknown> | undefined): string {
  if (!sync) return "";
  const state =
    typeof sync.state === "string"
      ? sync.state
      : typeof sync.status === "string"
        ? sync.status
        : "";
  if (!state) return "";
  const labels: Record<string, string> = {
    idle: "同步空闲",
    syncing: "同步中",
    synced: "已同步",
    ready: "已同步",
    error: "同步失败",
    failed: "同步失败",
    disabled: "同步未启用",
  };
  return labels[state.toLowerCase()] || `同步 ${state}`;
}

function isRemoteFailure(remote: DshHistoryRemoteStatus | undefined): boolean {
  return ["error", "failed", "offline", "disconnected"].includes(
    remote?.state?.toLowerCase() ?? "",
  );
}

function remoteConnectionNotice(
  remote: DshHistoryRemoteStatus | undefined,
): string {
  if (!remote) return "连接测试完成，但服务端没有返回远端状态。";
  const state = remoteStateLabel(remote?.state);
  const route = remoteRouteLabel(remote?.route);
  const node = remote?.nodeId?.trim();
  return ["连接测试", state, route, node ? `对端 ${node}` : ""]
    .filter(Boolean)
    .join(" · ");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "请求失败");
}
