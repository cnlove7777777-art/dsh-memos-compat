import { useEffect, useMemo, useState } from "react";

type Selection =
  | { mode: "follow" }
  | { mode: "fixed"; provider: string; model: string };

interface ModelOption {
  provider: string;
  providerName?: string;
  model: string;
  modelName?: string;
}

interface EmbeddingInfo {
  provider: string;
  model: string;
  dimension?: number;
  status: string;
}

interface SettingsSnapshot {
  selection: Selection;
  models: ModelOption[];
  embedding: EmbeddingInfo;
  enabled: boolean;
  viewerUrl?: string;
}

interface ModelTestResult {
  ok?: boolean;
  provider?: string;
  model?: string;
  latencyMs?: number;
  responseChars?: number;
  error?: string;
}

interface EmbeddingTestResult {
  ok?: boolean;
  dimensions?: number;
  dimension?: number;
  latencyMs?: number;
  status?: string;
  error?: string;
}

interface JsonErrorEnvelope {
  error?: {
    message?: string;
  };
}

interface TransportHooks {
  fetch?: typeof fetch;
}

interface SlotsContext {
  slots: {
    inject(name: string, callback: () => unknown): unknown;
    register(definition: Record<string, unknown>, component: () => unknown): unknown;
  };
}

const STYLE_ID = "@memtensor/memos-local-plugin/settings.css";
const SETTINGS_PATH = "/api/memos/settings";
const TEST_PATH = "/api/memos/test";
const EMBEDDING_TEST_PATH = "/api/memos/embedding-test";

const CSS = `
.memos-settings-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  max-width: 760px;
  color: var(--dsw-alias-label-primary);
}
.memos-settings-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.memos-settings-heading-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.memos-settings-title {
  margin: 0;
  font-size: 20px;
  font-weight: 500;
  line-height: 28px;
}
.memos-settings-intro,
.memos-settings-muted {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
.memos-settings-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border: .5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}
.memos-settings-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.memos-settings-card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
}
.memos-settings-status-row,
.memos-settings-chip-row,
.memos-settings-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.memos-settings-chip {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 1px 8px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
.memos-settings-chip[data-tone="good"] {
  border-color: transparent;
  color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-state-success-tertiary);
}
.memos-settings-chip[data-tone="warn"] {
  border-color: transparent;
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary);
}
.memos-settings-chip[data-tone="bad"] {
  border-color: transparent;
  color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-interactive-bg-hover-danger);
}
.memos-settings-mode-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.memos-settings-mode-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 12px;
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-lg);
  color: var(--dsw-alias-label-primary);
  text-align: left;
  background: transparent;
  cursor: pointer;
  font: inherit;
}
.memos-settings-mode-card:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.memos-settings-mode-card[data-active="true"] {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-tertiary);
}
.memos-settings-mode-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}
.memos-settings-mode-description {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.memos-settings-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.memos-settings-label {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}
.memos-settings-select {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 30px 0 10px;
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.memos-settings-select:focus-visible,
.memos-settings-button:focus-visible,
.memos-settings-mode-card:focus-visible,
.memos-settings-link:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.memos-settings-select:disabled {
  opacity: .55;
  cursor: default;
}
.memos-settings-note {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-module-platform);
  font-size: 12px;
  line-height: 18px;
}
.memos-settings-current {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 12px;
  border-top: .5px solid var(--dsw-alias-border-l2);
}
.memos-settings-route {
  color: var(--dsw-alias-label-primary);
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.memos-settings-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 0 14px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-primary);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.memos-settings-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.memos-settings-button[data-primary="true"] {
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground);
  background: var(--dsw-alias-button-primary-fill);
}
.memos-settings-button[data-primary="true"]:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}
.memos-settings-button:disabled,
.memos-settings-mode-card:disabled {
  opacity: .42;
  cursor: default;
}
.memos-settings-link {
  display: inline-flex;
  align-items: center;
  color: var(--dsw-alias-link);
  text-decoration: none;
  font-size: 13px;
  line-height: 20px;
}
.memos-settings-link:hover {
  text-decoration: underline;
}
.memos-settings-message {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
}
.memos-settings-message[data-tone="error"] {
  color: var(--dsw-alias-state-error-primary);
}
.memos-settings-message[data-tone="success"] {
  color: var(--dsw-alias-state-success-primary);
}
.memos-settings-message[data-tone="warn"] {
  color: var(--dsw-alias-state-warn-label);
}
.memos-settings-embedding-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.memos-settings-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
}
.memos-settings-metric-label {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 17px;
}
.memos-settings-metric-value {
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
@media (max-width: 560px) {
  .memos-settings-header {
    flex-direction: column;
  }
  .memos-settings-mode-grid,
  .memos-settings-embedding-grid {
    grid-template-columns: 1fr;
  }
}
`;

function ensureStyles(): void {
  if (typeof document === "undefined") return;
  const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
  if (existing !== null) {
    if (existing.textContent !== CSS) existing.textContent = CSS;
    return;
  }
  const style = document.createElement("style");
  style.dataset.plugin = "@memtensor/memos-local-plugin";
  style.dataset.pluginCss = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiError(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const envelope = payload as JsonErrorEnvelope;
  const message = envelope.error?.message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const transport = (globalThis as typeof globalThis & {
    __DSH_TRANSPORT__?: TransportHooks;
  }).__DSH_TRANSPORT__;
  const send = typeof transport?.fetch === "function"
    ? transport.fetch.bind(transport)
    : globalThis.fetch?.bind(globalThis);
  if (send === undefined) throw new Error("此页面没有可用的网络请求接口。");

  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await send(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`无法连接记忆插件接口：${message}`);
  }

  const text = await response.text();
  let payload: unknown;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`记忆插件接口返回了无效 JSON（HTTP ${response.status}）。`);
    }
  }

  const message = apiError(payload);
  if (!response.ok) {
    throw new Error(message ?? `记忆插件接口请求失败（HTTP ${response.status}）。`);
  }
  if (message !== undefined) throw new Error(message);
  return payload as T;
}

function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function selectionKey(selection: Selection): string {
  return selection.mode === "fixed"
    ? modelKey(selection.provider, selection.model)
    : "";
}

function displayModel(model: ModelOption | undefined): string {
  if (model === undefined) return "未选择";
  const provider = model.providerName?.trim() || model.provider;
  const name = model.modelName?.trim() || model.model;
  return `${provider} · ${name}`;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function SettingsView() {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [mode, setMode] = useState<"follow" | "fixed">("follow");
  const [fixedKey, setFixedKey] = useState("");
  const [testKey, setTestKey] = useState("");
  const [busy, setBusy] = useState<"" | "load" | "save" | "test" | "embedding">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testResult, setTestResult] = useState<ModelTestResult>();
  const [embeddingResult, setEmbeddingResult] = useState<EmbeddingTestResult>();

  const applySnapshot = (next: SettingsSnapshot) => {
    const keys = new Set(next.models.map((item) => modelKey(item.provider, item.model)));
    const savedKey = selectionKey(next.selection);
    setSnapshot(next);
    setMode(next.selection.mode);
    setFixedKey((previous) => {
      if (keys.has(previous)) return previous;
      if (savedKey && keys.has(savedKey)) return savedKey;
      const first = next.models[0];
      return first === undefined ? "" : modelKey(first.provider, first.model);
    });
    setTestKey((previous) => {
      if (keys.has(previous)) return previous;
      if (savedKey && keys.has(savedKey)) return savedKey;
      const first = next.models[0];
      return first === undefined ? "" : modelKey(first.provider, first.model);
    });
  };

  const load = async () => {
    setBusy("load");
    setError("");
    setNotice("");
    try {
      const next = await requestJson<SettingsSnapshot>(SETTINGS_PATH);
      applySnapshot(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const groupedModels = useMemo(() => {
    const groups = new Map<string, { label: string; models: ModelOption[] }>();
    for (const item of snapshot?.models ?? []) {
      const providerLabel = item.providerName?.trim() || item.provider;
      const group = groups.get(item.provider) ?? { label: providerLabel, models: [] };
      group.models.push(item);
      groups.set(item.provider, group);
    }
    return [...groups.entries()]
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .map(([provider, group]) => ({
        provider,
        label: group.label,
        models: group.models.sort((a, b) =>
          (a.modelName?.trim() || a.model).localeCompare(b.modelName?.trim() || b.model)
        ),
      }));
  }, [snapshot]);

  const modelsByKey = useMemo(() => {
    const rows = new Map<string, ModelOption>();
    for (const item of snapshot?.models ?? []) {
      rows.set(modelKey(item.provider, item.model), item);
    }
    return rows;
  }, [snapshot]);

  const fixedModel = modelsByKey.get(fixedKey);
  const testModel = modelsByKey.get(testKey);
  const savedKey = snapshot === undefined ? "" : selectionKey(snapshot.selection);
  const dirty = snapshot !== undefined && (
    mode !== snapshot.selection.mode
    || (mode === "fixed" && fixedKey !== savedKey)
  );
  const hasModels = (snapshot?.models.length ?? 0) > 0;
  const canSave = snapshot !== undefined
    && busy === ""
    && (mode === "follow" || fixedModel !== undefined)
    && (dirty || !snapshot.enabled);
  const canTest = snapshot !== undefined
    && busy === ""
    && (mode === "fixed" ? fixedModel !== undefined : testModel !== undefined);

  const draftSelection = (): Selection => {
    if (mode === "follow") return { mode: "follow" };
    if (fixedModel === undefined) {
      throw new Error("请选择一个固定的 DSH provider/model。");
    }
    return {
      mode: "fixed",
      provider: fixedModel.provider,
      model: fixedModel.model,
    };
  };

  const save = async () => {
    if (!canSave) return;
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const selection = draftSelection();
      const next = await requestJson<SettingsSnapshot>(SETTINGS_PATH, {
        method: "PUT",
        body: JSON.stringify(selection),
      });
      applySnapshot(next);
      setTestResult(undefined);
      setNotice(selection.mode === "follow"
        ? "已保存：记忆任务跟随各自所属的 DSH 对话模型。"
        : `已保存固定记忆模型：${displayModel(fixedModel)}。`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  };

  const test = async () => {
    if (!canTest) return;
    setBusy("test");
    setError("");
    setNotice("");
    setTestResult(undefined);
    try {
      const selection = draftSelection();
      const body = selection.mode === "follow" && testModel !== undefined
        ? {
            ...selection,
            testProvider: testModel.provider,
            testModel: testModel.model,
          }
        : selection;
      const result = await requestJson<ModelTestResult>(TEST_PATH, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (result.ok === false) throw new Error(result.error || "模型连接测试失败。");
      setTestResult(result);
      const route = [result.provider, result.model].filter(Boolean).join(" / ")
        || (selection.mode === "fixed"
          ? `${selection.provider} / ${selection.model}`
          : displayModel(testModel));
      const latency = finitePositive(result.latencyMs);
      setNotice(`连接测试通过：${route}${latency === undefined ? "" : `，${latency} ms`}。`);
    } catch (cause) {
      setError(`连接测试失败：${messageOf(cause)}`);
    } finally {
      setBusy("");
    }
  };

  const testEmbedding = async () => {
    setBusy("embedding");
    setError("");
    setNotice("");
    setEmbeddingResult(undefined);
    try {
      const result = await requestJson<EmbeddingTestResult>(EMBEDDING_TEST_PATH, {
        method: "POST",
      });
      if (result.ok === false) throw new Error(result.error || "嵌入测试失败。");
      const dimensions = finitePositive(result.dimensions) ?? finitePositive(result.dimension);
      if (dimensions === undefined) throw new Error("嵌入接口没有返回有效维度。");
      setEmbeddingResult(result);
      setNotice(`嵌入测试通过：${dimensions} 维。`);
    } catch (cause) {
      setError(`嵌入测试失败：${messageOf(cause)}`);
    } finally {
      setBusy("");
    }
  };

  const embeddingDimensions = finitePositive(embeddingResult?.dimensions)
    ?? finitePositive(embeddingResult?.dimension)
    ?? finitePositive(snapshot?.embedding.dimension);
  const embeddingStatus = embeddingResult?.status
    || snapshot?.embedding.status
    || "unknown";

  return (
    <section className="memos-settings-root" aria-labelledby="memos-settings-title">
      <header className="memos-settings-header">
        <div className="memos-settings-heading-copy">
          <h2 id="memos-settings-title" className="memos-settings-title">记忆插件</h2>
          <p className="memos-settings-intro">
            MemOS 长期记忆复用 DSH 已注册的模型与凭据。这里的选择只影响记忆提取、摘要、反思和技能演化。
          </p>
        </div>
        <button
          type="button"
          className="memos-settings-button"
          disabled={busy !== ""}
          onClick={() => void load()}
        >
          {busy === "load" ? "刷新中…" : "刷新"}
        </button>
      </header>

      {error !== "" && (
        <p className="memos-settings-message" data-tone="error" role="alert">{error}</p>
      )}
      {notice !== "" && (
        <p className="memos-settings-message" data-tone="success" role="status" aria-live="polite">
          {notice}
        </p>
      )}

      {snapshot === undefined && busy === "load" && (
        <p className="memos-settings-muted">正在读取记忆插件设置…</p>
      )}

      {snapshot !== undefined && (
        <>
          <div className="memos-settings-status-row">
            <span className="memos-settings-chip" data-tone={snapshot.enabled ? "good" : "warn"}>
              {snapshot.enabled ? "记忆模型已启用" : "尚未启用记忆模型"}
            </span>
            <span className="memos-settings-chip">
              {snapshot.selection.mode === "follow" ? "跟随所属会话" : "固定模型"}
            </span>
            <span className="memos-settings-chip">
              {snapshot.models.length} 个 DSH 模型
            </span>
            {snapshot.viewerUrl !== undefined && (
              <a
                className="memos-settings-link"
                href={snapshot.viewerUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开记忆面板 ↗
              </a>
            )}
          </div>

          <div className="memos-settings-card">
            <div className="memos-settings-card-head">
              <div>
                <h3 className="memos-settings-card-title">记忆模型路由</h3>
                <p className="memos-settings-muted">
                  固定模型不会修改 DSH 对话默认模型，也不会改变当前会话已经选用的聊天模型。
                </p>
              </div>
            </div>

            <div className="memos-settings-mode-grid" role="group" aria-label="记忆模型路由方式">
              <button
                type="button"
                className="memos-settings-mode-card"
                data-active={mode === "follow" ? "true" : "false"}
                aria-pressed={mode === "follow"}
                disabled={busy !== ""}
                onClick={() => {
                  setMode("follow");
                  setTestResult(undefined);
                  setNotice("");
                }}
              >
                <span className="memos-settings-mode-title">跟随所属会话</span>
                <span className="memos-settings-mode-description">
                  每个记忆任务使用真正拥有该任务的 DSH 会话当时选择的 provider/model。
                  这里不保存全局默认模型，也不会借用其他会话的模型。
                </span>
              </button>
              <button
                type="button"
                className="memos-settings-mode-card"
                data-active={mode === "fixed" ? "true" : "false"}
                aria-pressed={mode === "fixed"}
                disabled={busy !== "" || !hasModels}
                onClick={() => {
                  setMode("fixed");
                  setTestResult(undefined);
                  setNotice("");
                }}
              >
                <span className="memos-settings-mode-title">固定 DSH 模型</span>
                <span className="memos-settings-mode-description">
                  所有记忆模型任务都使用下方固定的 DSH provider/model，适合没有活动会话时的后台处理。
                </span>
              </button>
            </div>

            {mode === "fixed" && (
              <label className="memos-settings-field">
                <span className="memos-settings-label">记忆任务使用的 DSH 模型</span>
                <select
                  className="memos-settings-select"
                  value={fixedKey}
                  disabled={busy !== "" || !hasModels}
                  onChange={(event) => {
                    setFixedKey(event.currentTarget.value);
                    setTestResult(undefined);
                    setNotice("");
                  }}
                >
                  {!hasModels && <option value="">没有可用的 DSH 模型</option>}
                  {groupedModels.map((group) => (
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
              </label>
            )}

            <div className="memos-settings-current">
              <span className="memos-settings-label">当前已保存</span>
              <span className="memos-settings-route">
                {snapshot.selection.mode === "follow"
                  ? "follow · 使用每个记忆任务所属 DSH 会话的模型"
                  : `fixed · ${snapshot.selection.provider} / ${snapshot.selection.model}`}
              </span>
              {!snapshot.enabled && (
                <p className="memos-settings-message" data-tone="warn">
                  保存一次模型配置后会启用 DSH 托管的记忆模型。
                </p>
              )}
            </div>
          </div>

          <div className="memos-settings-card">
            <div>
              <h3 className="memos-settings-card-title">保存与连接测试</h3>
              <p className="memos-settings-muted">
                测试会发送一个很小的真实 DSH 模型请求，不需要再次填写 API Key。
              </p>
            </div>

            {mode === "follow" && (
              <label className="memos-settings-field">
                <span className="memos-settings-label">测试时使用的 DSH 模型</span>
                <select
                  className="memos-settings-select"
                  value={testKey}
                  disabled={busy !== "" || !hasModels}
                  onChange={(event) => {
                    setTestKey(event.currentTarget.value);
                    setTestResult(undefined);
                    setNotice("");
                  }}
                >
                  {!hasModels && <option value="">没有可用的 DSH 模型</option>}
                  {groupedModels.map((group) => (
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
                <span className="memos-settings-muted">
                  这个模型只用于本次 settings 页连接测试，不会保存，也不会成为 DSH 默认模型。
                  若测试发生在有活动会话的请求作用域内，服务端会优先使用该会话的真实路由。
                </span>
              </label>
            )}

            <div className="memos-settings-actions">
              <button
                type="button"
                className="memos-settings-button"
                disabled={!canTest}
                onClick={() => void test()}
              >
                {busy === "test" ? "测试中…" : "测试连接"}
              </button>
              <button
                type="button"
                className="memos-settings-button"
                data-primary="true"
                disabled={!canSave}
                onClick={() => void save()}
              >
                {busy === "save" ? "保存中…" : "保存"}
              </button>
            </div>

            {testResult !== undefined && (
              <div className="memos-settings-chip-row">
                {testResult.provider !== undefined && (
                  <span className="memos-settings-chip">{testResult.provider}</span>
                )}
                {testResult.model !== undefined && (
                  <span className="memos-settings-chip">{testResult.model}</span>
                )}
                {finitePositive(testResult.latencyMs) !== undefined && (
                  <span className="memos-settings-chip">{testResult.latencyMs} ms</span>
                )}
              </div>
            )}
          </div>

          <div className="memos-settings-card">
            <div className="memos-settings-card-head">
              <div>
                <h3 className="memos-settings-card-title">嵌入模型</h3>
                <p className="memos-settings-muted">
                  嵌入负责记忆检索向量；这里只读取当前运行配置并执行一次真实嵌入探测。
                </p>
              </div>
              <span
                className="memos-settings-chip"
                data-tone={embeddingStatus === "ready" || embeddingResult?.ok === true ? "good" : "warn"}
              >
                {embeddingStatus}
              </span>
            </div>

            <div className="memos-settings-embedding-grid">
              <div className="memos-settings-metric">
                <span className="memos-settings-metric-label">Provider</span>
                <span className="memos-settings-metric-value">{snapshot.embedding.provider}</span>
              </div>
              <div className="memos-settings-metric">
                <span className="memos-settings-metric-label">模型</span>
                <span className="memos-settings-metric-value">{snapshot.embedding.model}</span>
              </div>
              <div className="memos-settings-metric">
                <span className="memos-settings-metric-label">向量维度</span>
                <span className="memos-settings-metric-value">
                  {embeddingDimensions === undefined ? "未知" : String(embeddingDimensions)}
                </span>
              </div>
            </div>

            <div className="memos-settings-actions">
              <button
                type="button"
                className="memos-settings-button"
                disabled={busy !== ""}
                onClick={() => void testEmbedding()}
              >
                {busy === "embedding" ? "测试中…" : "测试嵌入"}
              </button>
              {finitePositive(embeddingResult?.latencyMs) !== undefined && (
                <span className="memos-settings-chip">{embeddingResult?.latencyMs} ms</span>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export const inject = ["slots"];

export function apply(ctx: SlotsContext): void {
  ensureStyles();
  ctx.slots.inject("settings.section", () => ctx.slots.register(
    {
      name: "settings.section",
      id: "memos-memory",
      order: 20,
      label: () => "记忆插件",
    },
    SettingsView,
  ));
}
