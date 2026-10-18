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

export interface DshHistoryConfig {
  enabled: boolean;
  codexRoot: string;
  dshRoot: string;
  recentDays: number;
  backgroundModel?: DshHistoryBackgroundModel;
  remote: {
    enabled: boolean;
    url: string;
    tokenFile: string;
    tunnelFile?: string;
  };
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

export interface DshHistorySnapshot {
  config: DshHistoryConfig;
  status: DshHistoryStatus;
  mcp: DshHistoryMcp;
}

export interface DshHistoryModelOption {
  provider: string;
  providerName?: string;
  model: string;
  modelName?: string;
}

const MEMORY_ROUTE_VALUE = "__memory_route__";

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
  const [action, setAction] = useState<"save" | "run" | "refresh" | null>(null);
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
        draft,
      );
      setSnapshot(next);
      setDraft(configDraft(next.config));
      setCapability("available");
      setNotice({
        kind: "ok",
        text: "历史互通设置已保存。需要立即导入时请单独运行一次。",
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
    setAction("refresh");
    setNotice(null);
    try {
      const next = await api.get<DshHistorySnapshot>("/api/v1/dsh/history");
      setSnapshot(next);
      setDraft((previous) =>
        previous === null || dirty ? previous : configDraft(next.config),
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
          Token 仅引用文件
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
            启用只影响配置，不会自动导入；保存后仍需点击运行。
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
              启用指定远端记忆库
            </span>
            <span class="muted" style="display:block;font-size:var(--fs-xs);line-height:1.6">
              只连接显式 URL；不扫描网络，不复制原始 Codex 会话。
            </span>
          </span>
        </label>

        <div
          style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--sp-4);margin-top:var(--sp-4)"
        >
          <Field label="远端 API 地址">
            <input
              class="input"
              type="url"
              value={draft.remote.url}
              disabled={busy}
              spellcheck={false}
              placeholder="https://memory.example.com"
              onInput={(event) =>
                patchRemote({ url: (event.target as HTMLInputElement).value })
              }
            />
          </Field>
          <Field label="Token 文件（JSON）">
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
          <Field label="SSH 设置 JSON（可选）">
            <input
              class="input"
              value={draft.remote.tunnelFile ?? ""}
              disabled={busy}
              spellcheck={false}
              placeholder="C:\\secrets\\ssh-settings.json"
              onInput={(event) =>
                patchRemote({
                  tunnelFile: (event.target as HTMLInputElement).value,
                })
              }
            />
          </Field>
        </div>
        <div
          class="muted"
          style="margin-top:var(--sp-2);font-size:var(--fs-xs);line-height:1.6"
        >
          这里只填写已有 JSON 文件的路径，不显示或保存 token 内容；不会扫描目录。
        </div>
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

function configDraft(config: DshHistoryConfig): DshHistoryConfig {
  return {
    enabled: config.enabled,
    codexRoot: config.codexRoot,
    dshRoot: config.dshRoot,
    recentDays: config.recentDays,
    ...(config.backgroundModel === undefined
      ? {}
      : { backgroundModel: config.backgroundModel }),
    remote: { ...config.remote },
  };
}

function sameConfig(left: DshHistoryConfig, right: DshHistoryConfig): boolean {
  return (
    left.enabled === right.enabled &&
    left.codexRoot === right.codexRoot &&
    left.dshRoot === right.dshRoot &&
    left.recentDays === right.recentDays &&
    modelKeyOf(left.backgroundModel) === modelKeyOf(right.backgroundModel) &&
    left.remote.enabled === right.remote.enabled &&
    left.remote.url === right.remote.url &&
    left.remote.tokenFile === right.remote.tokenFile &&
    (left.remote.tunnelFile ?? "") === (right.remote.tunnelFile ?? "")
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

function formatTimestamp(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return "尚未运行";
  }
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "请求失败");
}
