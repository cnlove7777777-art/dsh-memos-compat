/**
 * DSH-managed memory model controls.
 *
 * DSH owns provider credentials and model routing. The Viewer only stores the
 * memory-specific selection and asks DSH to validate/dispatch test calls.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api/client";
import { Icon } from "./Icon";
import {
  buildDshSavePayload,
  buildDshTestPayload,
  type DshMemorySelection,
} from "./dsh-memory-settings-payload";

export type { DshMemorySelection };

export interface DshModelOption {
  provider: string;
  providerName?: string;
  model: string;
  modelName?: string;
}

export interface DshEmbeddingSnapshot {
  provider: string;
  model: string;
  dimension: number;
  status: string;
}

export interface DshSettingsSnapshot {
  selection: DshMemorySelection;
  models: DshModelOption[];
  embedding: DshEmbeddingSnapshot;
  /** Providers whose model catalog could not be read this time. */
  failures?: Array<{ provider: string; message: string }>;
  enabled: boolean;
  viewerUrl?: string;
}

export interface DshModelTestResult {
  ok: boolean;
  provider?: string;
  model?: string;
  latencyMs?: number;
  responseChars?: number;
}

export interface DshEmbeddingTestResult {
  ok: true;
  dimensions: number;
  latencyMs: number;
}

export type DshCapability =
  | { status: "checking" }
  | { status: "available"; snapshot: DshSettingsSnapshot }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export function DshMemorySettings({
  initial,
  onSnapshot,
}: {
  initial: DshSettingsSnapshot;
  onSnapshot: (snapshot: DshSettingsSnapshot) => void;
}) {
  const [current, setCurrent] = useState(initial);
  const [draft, setDraft] = useState<DshMemorySelection>(initial.selection);
  const [action, setAction] = useState<"save" | "test" | "embedding" | null>(
    null,
  );
  const [saveStatus, setSaveStatus] = useState<Status | null>(null);
  const [testStatus, setTestStatus] = useState<Status | null>(null);
  const [embeddingTest, setEmbeddingTest] =
    useState<DshEmbeddingTestResult | null>(null);
  const [embeddingError, setEmbeddingError] = useState<string | null>(null);
  const [testProvider, setTestProvider] = useState("");
  const [testModel, setTestModel] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setCurrent(initial);
    setDraft(initial.selection);
  }, [initial]);

  const providers = useMemo(
    () => buildProviderOptions(current.models, current.selection),
    [current.models, current.selection],
  );
  const testProviders = useMemo(
    () => buildProviderOptions(current.models),
    [current.models],
  );

  const fixedProvider = draft.mode === "fixed" ? draft.provider : "";
  const fixedModels = useMemo(
    () =>
      buildModelOptions(
        current.models,
        fixedProvider,
        draft.mode === "fixed" ? draft.model : "",
      ),
    [current.models, fixedProvider, draft],
  );
  const testModels = useMemo(
    () => buildModelOptions(current.models, testProvider, testModel),
    [current.models, testProvider, testModel],
  );

  const fixedReady =
    draft.mode === "fixed" && !!draft.provider.trim() && !!draft.model.trim();
  const testRouteReady = !!testProvider.trim() && !!testModel.trim();
  const testReady = draft.mode === "follow" ? testRouteReady : fixedReady;
  const busy = action !== null;

  const switchMode = (mode: DshMemorySelection["mode"]) => {
    setSaveStatus(null);
    setTestStatus(null);
    setSaved(false);
    if (mode === "follow") {
      setDraft({ mode: "follow" });
      return;
    }
    const first = current.models[0];
    setDraft({
      mode: "fixed",
      provider: first?.provider ?? "",
      model: first?.model ?? "",
    });
  };

  const selectProvider = (provider: string) => {
    setSaveStatus(null);
    setSaved(false);
    const firstModel = current.models.find((row) => row.provider === provider);
    setDraft({
      mode: "fixed",
      provider,
      model: firstModel?.model ?? "",
    });
  };

  const selectModel = (model: string) => {
    setSaveStatus(null);
    setSaved(false);
    setDraft({ mode: "fixed", provider: fixedProvider, model });
  };

  const selectTestProvider = (provider: string) => {
    const firstModel = current.models.find((row) => row.provider === provider);
    setTestProvider(provider);
    setTestModel(firstModel?.model ?? "");
  };

  const save = async () => {
    setAction("save");
    setSaveStatus(null);
    try {
      const persisted = await api.put<DshSettingsSnapshot>(
        "/api/v1/dsh/settings",
        buildDshSavePayload(draft),
      );
      setCurrent(persisted);
      setDraft(persisted.selection);
      onSnapshot(persisted);
      setSaved(true);
      setSaveStatus({
        kind: "ok",
        text: "已保存并立即生效，无需重启 DSH。",
      });
    } catch (error) {
      setSaveStatus({ kind: "error", text: errorMessage(error) });
    } finally {
      setAction(null);
    }
  };

  const test = async () => {
    setAction("test");
    setTestStatus(null);
    try {
      const result = await api.post<DshModelTestResult>(
        "/api/v1/dsh/test",
        buildDshTestPayload(
          draft,
          draft.mode === "follow"
            ? { provider: testProvider, model: testModel }
            : undefined,
        ),
      );
      setTestStatus(
        result.ok
          ? {
              kind: "ok",
              text: [
                `测试通过：${result.provider ?? "DSH"} / ${result.model ?? "model"}`,
                result.latencyMs != null ? `${result.latencyMs}ms` : "",
                result.responseChars != null
                  ? `${result.responseChars} chars`
                  : "",
              ]
                .filter(Boolean)
                .join(" · "),
            }
          : { kind: "error", text: "模型测试未通过。" },
      );
    } catch (error) {
      setTestStatus({ kind: "error", text: errorMessage(error) });
    } finally {
      setAction(null);
    }
  };

  const probeEmbedding = async () => {
    setAction("embedding");
    setEmbeddingTest(null);
    setEmbeddingError(null);
    try {
      setEmbeddingTest(
        await api.post<DshEmbeddingTestResult>(
          "/api/v1/dsh/embedding-test",
          {},
        ),
      );
    } catch (error) {
      setEmbeddingError(errorMessage(error));
    } finally {
      setAction(null);
    }
  };

  return (
    <section class="card" style="border-left:3px solid var(--accent)">
      <div class="card__header">
        <div class="hstack" style="align-items:flex-start">
          <span
            aria-hidden="true"
            style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-md);background:var(--accent-soft);color:var(--accent);flex-shrink:0"
          >
            <Icon name="brain-circuit" size={16} />
          </span>
          <div>
            <div class="hstack" style="gap:var(--sp-2);flex-wrap:wrap">
              <h3 class="card__title" style="margin:0">
                记忆插件 · DSH 模型
              </h3>
              <span
                class={`pill ${current.enabled ? "pill--active" : "pill--draft"}`}
              >
                {current.enabled ? "已启用" : "未启用"}
              </span>
            </div>
            <p class="card__subtitle" style="margin:4px 0 0">
              记忆提取、任务摘要和技能进化共用这一套 DSH 模型选择。
            </p>
          </div>
        </div>
        <span class="muted" style="font-size:var(--fs-xs)">
          凭证由 DSH 管理
        </span>
      </div>

      <div
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--sp-3);margin-bottom:var(--sp-4)"
      >
        <ModeNote
          title="跟随对话"
          desc="复用正在驱动当前 DSH 对话的 provider / model；切换会话时自动跟随该会话。"
        />
        <ModeNote
          title="固定模型"
          desc="只作用于记忆提取、摘要和技能进化，不会修改 DSH 的默认模型或新会话选择。"
        />
      </div>

      {!current.enabled && (
        <div
          style="margin-bottom:var(--sp-4);padding:var(--sp-3);border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg-canvas);font-size:var(--fs-sm);color:var(--fg-muted)"
        >
          当前记忆模型能力尚未启用。保存一次模型选择后会立即激活，无需重启 DSH。
        </div>
      )}

      <div
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--sp-4)"
      >
        <Field label="配置方式">
          <div class="segmented">
            <button
              class="segmented__item"
              aria-pressed={draft.mode === "follow"}
              onClick={() => switchMode("follow")}
              disabled={busy}
            >
              跟随对话
            </button>
            <button
              class="segmented__item"
              aria-pressed={draft.mode === "fixed"}
              onClick={() => switchMode("fixed")}
              disabled={busy}
            >
              固定模型
            </button>
          </div>
        </Field>

        {draft.mode === "fixed" && (
          <>
            <Field label="DSH Provider">
              <select
                class="select"
                value={draft.provider}
                onInput={(e) =>
                  selectProvider((e.target as HTMLSelectElement).value)
                }
                disabled={busy || providers.length === 0}
              >
                {providers.length === 0 && (
                  <option value="">DSH 模型目录不可用</option>
                )}
                {providers.map((provider) => (
                  <option key={provider.provider} value={provider.provider}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="记忆模型">
              <select
                class="select"
                value={draft.model}
                onInput={(e) =>
                  selectModel((e.target as HTMLSelectElement).value)
                }
                disabled={busy || fixedModels.length === 0}
              >
                {fixedModels.length === 0 && (
                  <option value="">该 Provider 暂无可用模型</option>
                )}
                {fixedModels.map((model) => (
                  <option key={model.model} value={model.model}>
                    {model.label}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
      </div>

      {draft.mode === "follow" && (
        <div
          style="margin-top:var(--sp-3);padding:var(--sp-3);border:1px dashed var(--border);border-radius:var(--radius-md);background:var(--bg-canvas)"
        >
          <p style="margin:0;font-size:var(--fs-sm)">为本次测试临时指定 DSH 模型</p>
          <div
            class="muted"
            style="font-size:var(--fs-xs);line-height:1.6;margin-top:4px"
          >
            设置页面不属于某个对话。请为本次测试选择模型；该选择不会保存，也不会改变跟随模式。
          </div>
          {(
            <div
              style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:var(--sp-3);margin-top:var(--sp-3)"
            >
              <Field label="测试 Provider">
                <select
                  class="select"
                  value={testProvider}
                  onInput={(e) =>
                    selectTestProvider(
                      (e.target as HTMLSelectElement).value,
                    )
                  }
                  disabled={busy || testProviders.length === 0}
                >
                  <option value="">选择 Provider</option>
                  {testProviders.map((provider) => (
                    <option key={provider.provider} value={provider.provider}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="测试模型">
                <select
                  class="select"
                  value={testModel}
                  onInput={(e) =>
                    setTestModel((e.target as HTMLSelectElement).value)
                  }
                  disabled={busy || testModels.length === 0}
                >
                  <option value="">选择模型</option>
                  {testModels.map((model) => (
                    <option key={model.model} value={model.model}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
        </div>
      )}

      <div
        class="hstack"
        style="gap:var(--sp-2);flex-wrap:wrap;margin-top:var(--sp-4)"
      >
        <button
          class="btn btn--sm"
          onClick={() => void test()}
          disabled={busy || !testReady}
        >
          <Icon
            name={action === "test" ? "loader-2" : "plug"}
            size={14}
            class={action === "test" ? "spin" : ""}
          />
          {action === "test" ? "测试中…" : "测试当前选择"}
        </button>
        <button
          class="btn btn--primary btn--sm"
          onClick={() => void save()}
          disabled={busy || (!fixedReady && draft.mode === "fixed") || saved}
        >
          <Icon
            name={action === "save" ? "loader-2" : "check"}
            size={14}
            class={action === "save" ? "spin" : ""}
          />
          {action === "save"
            ? "保存中…"
            : saved
              ? "已保存"
              : "保存并立即启用"}
        </button>
      </div>

      {saveStatus && <StatusLine status={saveStatus} />}
      {testStatus && <StatusLine status={testStatus} />}

      <div
        style="margin-top:var(--sp-5);padding-top:var(--sp-4);border-top:1px solid var(--border)"
      >
        <div
          class="hstack"
          style="justify-content:space-between;gap:var(--sp-3);align-items:flex-start;flex-wrap:wrap"
        >
          <div>
            <h4
              class="card__title"
              style="font-size:var(--fs-md);margin:0 0 4px 0"
            >
              Embedding 运行状态
            </h4>
            <div class="muted" style="font-size:var(--fs-xs)">
              这里的探测直接使用当前登录的 DSH 记忆插件运行配置。
            </div>
          </div>
          <button
            class="btn btn--sm"
            onClick={() => void probeEmbedding()}
            disabled={busy}
          >
            <Icon
              name={action === "embedding" ? "loader-2" : "gauge"}
              size={14}
              class={action === "embedding" ? "spin" : ""}
            />
            {action === "embedding" ? "探测中…" : "探测 Embedding"}
          </button>
        </div>

        <div
          style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--sp-3);margin-top:var(--sp-3)"
        >
          <RuntimeValue label="Provider" value={current.embedding.provider || "—"} />
          <RuntimeValue label="Model" value={current.embedding.model || "—"} />
          <RuntimeValue
            label="维度"
            value={
              current.embedding.dimension
                ? String(current.embedding.dimension)
                : "—"
            }
          />
          <RuntimeValue
            label="状态"
            value={
              current.embedding.status === "ready"
                ? "就绪"
                : current.embedding.status || "未知"
            }
            accent={current.embedding.status === "ready"}
          />
        </div>
        {!!current.failures?.length && (
          <div
            class="muted"
            style="margin-top:var(--sp-2);font-size:var(--fs-xs);line-height:1.6"
          >
            部分 Provider 目录暂不可用：
            {current.failures.map((row) => row.provider).join("、")}
          </div>
        )}

        {(embeddingTest || embeddingError) && (
          <div
            role="status"
            class="hstack"
            style={`margin-top:var(--sp-3);padding:var(--sp-2) var(--sp-3);border-radius:var(--radius-sm);background:${
              embeddingTest ? "var(--success-soft)" : "var(--danger-soft)"
            };color:${
              embeddingTest ? "var(--success)" : "var(--danger)"
            };font-size:var(--fs-xs)`}
          >
            <Icon
              name={embeddingTest ? "check" : "circle-alert"}
              size={14}
            />
            {embeddingTest
              ? `Embedding 测试通过 · ${embeddingTest.dimensions} 维 · ${embeddingTest.latencyMs}ms`
              : `Embedding 测试失败：${embeddingError}`}
          </div>
        )}
      </div>
    </section>
  );
}

function ModeNote({ title, desc }: { title: string; desc: string }) {
  return (
    <div
      style="padding:var(--sp-3);border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg-canvas)"
    >
      <div style="font-size:var(--fs-sm);font-weight:var(--fw-semi)">
        {title}
      </div>
      <div
        class="muted"
        style="font-size:var(--fs-xs);line-height:1.65;margin-top:4px"
      >
        {desc}
      </div>
    </div>
  );
}

function RuntimeValue({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      style="min-width:0;padding:var(--sp-3);border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg-canvas)"
    >
      <div
        class="muted"
        style="font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em"
      >
        {label}
      </div>
      <div
        title={value}
        style={`margin-top:4px;font-family:var(--font-mono);font-size:var(--fs-xs);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${
          accent ? "var(--success)" : "var(--fg)"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

type Status = { kind: "ok" | "error"; text: string };

function StatusLine({ status }: { status: Status }) {
  return (
    <div
      role="status"
      class="hstack"
      style={`margin-top:var(--sp-3);padding:var(--sp-2) var(--sp-3);border-radius:var(--radius-sm);background:${
        status.kind === "ok" ? "var(--success-soft)" : "var(--danger-soft)"
      };color:${
        status.kind === "ok" ? "var(--success)" : "var(--danger)"
      };font-size:var(--fs-xs)`}
    >
      <Icon
        name={status.kind === "ok" ? "check" : "circle-alert"}
        size={14}
      />
      <span>{status.text}</span>
    </div>
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

function buildProviderOptions(
  models: DshModelOption[],
  selected?: DshMemorySelection,
): Array<{ provider: string; label: string }> {
  const rows: Array<{ provider: string; label: string }> = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (!model.provider || seen.has(model.provider)) continue;
    seen.add(model.provider);
    rows.push({
      provider: model.provider,
      label: model.providerName
        ? `${model.providerName} · ${model.provider}`
        : model.provider,
    });
  }
  if (
    selected?.mode === "fixed" &&
    selected.provider &&
    !seen.has(selected.provider)
  ) {
    rows.unshift({
      provider: selected.provider,
      label: `${selected.provider} · 当前目录中不存在`,
    });
  }
  return rows;
}

function buildModelOptions(
  models: DshModelOption[],
  provider: string,
  selectedModel = "",
): Array<{ model: string; label: string }> {
  const rows: Array<{ model: string; label: string }> = [];
  const seen = new Set<string>();
  for (const row of models) {
    if (row.provider !== provider || !row.model || seen.has(row.model)) continue;
    seen.add(row.model);
    rows.push({
      model: row.model,
      label: row.modelName
        ? `${row.modelName} · ${row.model}`
        : row.model,
    });
  }
  if (selectedModel && !seen.has(selectedModel)) {
    rows.unshift({
      model: selectedModel,
      label: `${selectedModel} · 当前目录中不存在`,
    });
  }
  return rows;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "请求失败");
}
