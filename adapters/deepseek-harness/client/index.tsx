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

interface HistoryBackgroundModel {
  provider: string;
  model: string;
}

interface HistoryRemoteConfig {
  enabled: boolean;
  url: string;
  tokenFile: string;
  /** Legacy response field; accepted for compatibility but never submitted. */
  tunnelFile?: string;
  /** Write-only values stay in component state and are cleared after save. */
  pairingKey?: string;
  session?: string;
  nodeId?: string;
  expectedNodeId?: string;
  lanDiscovery?: boolean;
  peerPort?: number | string;
  pollIntervalSeconds?: number | string;
  syncEnabled?: boolean;
  sessionFile?: string;
  hasPairingKey?: boolean;
  hasSession?: boolean;
}

interface HistoryConfig {
  enabled: boolean;
  codexRoot: string;
  dshRoot: string;
  recentDays: number;
  backgroundModel?: HistoryBackgroundModel;
  remote: HistoryRemoteConfig;
}

interface HistoryStatus {
  running: boolean;
  lastRunAt?: number;
  imported: number;
  skipped: number;
  waitingForModel: boolean;
  lastError?: string;
  skippedFiles?: number;
  lastWarning?: string;
}

interface HistoryMcp {
  url?: string;
  enabled: boolean;
}

interface HistorySnapshot {
  config: HistoryConfig;
  status: HistoryStatus;
  mcp: HistoryMcp;
  remote?: HistoryRemoteStatus;
}

interface HistoryRemoteStatus {
  state: string;
  route?: "lan" | "wan" | "offline" | (string & {});
  url?: string;
  nodeId?: string;
  lastConnectedAt?: number;
  lastError?: string;
  sync?: unknown;
}

interface JsonErrorEnvelope {
  error?: {
    message?: string;
  };
}

interface TransportHooks {
  fetch?: typeof fetch;
}

interface HistoryApiFailure {
  status?: number;
  message: string;
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
const HISTORY_PATH = "/api/memos/history";
const HISTORY_RUN_PATH = "/api/memos/history-run";
export const HISTORY_CONNECT_PATH = "/api/memos/history/connect";
const MEMORY_ROUTE_VALUE = "__memory_route__";
const DEFAULT_PEER_PORT = 18_802;
const DEFAULT_POLL_INTERVAL_SECONDS = 30;

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
.memos-settings-input {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  font: inherit;
  font-size: 13px;
}
.memos-settings-input::placeholder {
  color: var(--dsw-alias-label-tertiary);
}
.memos-settings-input:focus-visible,
.memos-settings-select:focus-visible,
.memos-settings-button:focus-visible,
.memos-settings-mode-card:focus-visible,
.memos-settings-link:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.memos-settings-select:disabled,
.memos-settings-input:disabled {
  opacity: .55;
  cursor: default;
}
.memos-settings-check-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}
.memos-settings-check-row input {
  width: 16px;
  height: 16px;
  margin: 1px 0 0;
  accent-color: var(--dsw-alias-state-business-primary);
}
.memos-settings-check-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.memos-settings-check-title {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}
.memos-settings-field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.memos-settings-peer-toggle-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.memos-settings-readonly {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
}
.memos-settings-divider {
  height: .5px;
  background: var(--dsw-alias-border-l2);
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
.memos-settings-details {
  border-top: .5px solid var(--dsw-alias-border-l2);
}
.memos-settings-details > summary {
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 20px;
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
  .memos-settings-embedding-grid,
  .memos-settings-field-grid {
    grid-template-columns: 1fr;
  }
  .memos-settings-peer-toggle-grid {
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
    const failure = new Error(
      message ?? `记忆插件接口请求失败（HTTP ${response.status}）。`,
    ) as Error & { status?: number };
    failure.status = response.status;
    throw failure;
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

function historyFailureOf(cause: unknown): HistoryApiFailure {
  const status = (cause as { status?: unknown } | null)?.status;
  return {
    status: typeof status === "number" ? status : undefined,
    message: messageOf(cause),
  };
}

function formatTimestamp(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "尚未运行";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatConnectedAt(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "尚未连接";
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

function remoteStateTone(state: string | undefined): "good" | "warn" | "bad" {
  switch (state?.toLowerCase()) {
    case "connected":
    case "online":
    case "ready":
      return "good";
    case "error":
    case "failed":
      return "bad";
    default:
      return "warn";
  }
}

function remoteStateFailed(state: string | undefined): boolean {
  return ["error", "failed", "offline", "disconnected"].includes(state?.toLowerCase() ?? "");
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

function syncCount(sync: unknown): number | undefined {
  if (!isRecord(sync)) return undefined;
  const direct = finitePositive(sync.synced ?? sync.count ?? sync.items);
  if (direct !== undefined) return direct;
  if (!isRecord(sync.replicas)) return undefined;
  let total = 0;
  for (const value of Object.values(sync.replicas)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

function remoteConnectionMessage(remote: HistoryRemoteStatus | undefined): string {
  if (remote === undefined) return "连接测试完成，但服务端没有返回远端状态。";
  const route = remoteRouteLabel(remote.route);
  const nodeId = remote.nodeId?.trim();
  return ["连接测试", remoteStateLabel(remote.state), route, nodeId ? `对端 ${nodeId}` : ""]
    .filter(Boolean)
    .join(" · ");
}

function clampRecentDays(value: number): number {
  return Math.min(30, Math.max(1, Math.round(value)));
}

function clampNumber(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function historyPeerPort(value: unknown): number {
  return clampNumber(Number(value), DEFAULT_PEER_PORT, 1_024, 65_535);
}

function historyPollInterval(value: unknown): number {
  return clampNumber(
    Number(value),
    DEFAULT_POLL_INTERVAL_SECONDS,
    15,
    3_600,
  );
}

function historyModelKey(model: HistoryBackgroundModel | undefined): string {
  return model === undefined
    ? MEMORY_ROUTE_VALUE
    : modelKey(model.provider, model.model);
}

function parseHistoryModelKey(value: string): HistoryBackgroundModel | undefined {
  if (value === MEMORY_ROUTE_VALUE) return undefined;
  const separator = value.indexOf("\u0000");
  if (separator <= 0) return undefined;
  const provider = value.slice(0, separator);
  const model = value.slice(separator + 1);
  return provider && model ? { provider, model } : undefined;
}

function historyConfigDraft(snapshot: HistorySnapshot): HistoryConfig {
  return {
    enabled: snapshot.config.enabled,
    codexRoot: snapshot.config.codexRoot,
    dshRoot: snapshot.config.dshRoot,
    recentDays: snapshot.config.recentDays,
    ...(snapshot.config.backgroundModel === undefined
      ? {}
      : { backgroundModel: snapshot.config.backgroundModel }),
    remote: historyRemoteDraft(snapshot.config.remote),
  };
}

function historyRemoteDraft(remote: HistoryRemoteConfig): HistoryRemoteConfig {
  return {
    enabled: remote.enabled,
    url: remote.url,
    tokenFile: remote.tokenFile,
    ...(remote.sessionFile === undefined ? {} : { sessionFile: remote.sessionFile }),
    ...(remote.nodeId === undefined ? {} : { nodeId: remote.nodeId }),
    ...(remote.expectedNodeId === undefined ? {} : { expectedNodeId: remote.expectedNodeId }),
    lanDiscovery: remote.lanDiscovery !== false,
    peerPort: historyPeerPort(remote.peerPort),
    pollIntervalSeconds: historyPollInterval(remote.pollIntervalSeconds),
    ...(remote.syncEnabled === undefined ? {} : { syncEnabled: remote.syncEnabled }),
    ...(remote.hasPairingKey === true ? { hasPairingKey: true } : {}),
    ...(remote.hasSession === true ? { hasSession: true } : {}),
  };
}

function historyDraftAfterResponse(
  previous: HistoryConfig | undefined,
  configAtStart: HistoryConfig,
  next: HistorySnapshot,
): HistoryConfig {
  if (previous !== undefined && !sameHistoryConfig(previous, configAtStart)) {
    return previous;
  }
  return historyConfigDraft(next);
}

export function historyDraftAfterStatusRefresh(
  previous: HistoryConfig | undefined,
  configAtStart: HistoryConfig | undefined,
  next: HistorySnapshot,
): HistoryConfig {
  if (
    previous !== undefined
    && configAtStart !== undefined
    && !sameHistoryConfig(previous, configAtStart)
  ) {
    return previous;
  }
  return historyConfigDraft(next);
}

export function buildHistorySavePayload(config: HistoryConfig): HistoryConfig {
  return {
    enabled: config.enabled,
    codexRoot: config.codexRoot,
    dshRoot: config.dshRoot,
    recentDays: config.recentDays,
    ...(config.backgroundModel === undefined
      ? {}
      : { backgroundModel: config.backgroundModel }),
    remote: {
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
      peerPort: historyPeerPort(config.remote.peerPort),
      pollIntervalSeconds: historyPollInterval(config.remote.pollIntervalSeconds),
      ...(config.remote.syncEnabled === undefined
        ? {}
        : { syncEnabled: config.remote.syncEnabled }),
      ...(config.remote.pairingKey?.trim()
        ? { pairingKey: config.remote.pairingKey }
        : {}),
      ...(config.remote.session?.trim()
        ? { session: config.remote.session }
        : {}),
    },
  };
}

function sameHistoryConfig(left: HistoryConfig, right: HistoryConfig): boolean {
  return left.enabled === right.enabled
    && left.codexRoot === right.codexRoot
    && left.dshRoot === right.dshRoot
    && left.recentDays === right.recentDays
    && historyModelKey(left.backgroundModel) === historyModelKey(right.backgroundModel)
    && left.remote.enabled === right.remote.enabled
    && left.remote.url === right.remote.url
    && left.remote.tokenFile === right.remote.tokenFile
    && (left.remote.sessionFile ?? "") === (right.remote.sessionFile ?? "")
    && (left.remote.nodeId ?? "") === (right.remote.nodeId ?? "")
    && (left.remote.expectedNodeId ?? "") === (right.remote.expectedNodeId ?? "")
    && (left.remote.lanDiscovery !== false) === (right.remote.lanDiscovery !== false)
    && historyPeerPort(left.remote.peerPort) === historyPeerPort(right.remote.peerPort)
    && historyPollInterval(left.remote.pollIntervalSeconds)
      === historyPollInterval(right.remote.pollIntervalSeconds)
    && left.remote.syncEnabled === right.remote.syncEnabled
    && (left.remote.pairingKey ?? "") === (right.remote.pairingKey ?? "")
    && (left.remote.session ?? "") === (right.remote.session ?? "");
}

function historyModelGroups(models: ModelOption[]) {
  const groups = new Map<string, { label: string; models: ModelOption[] }>();
  for (const item of models) {
    const group = groups.get(item.provider) ?? {
      label: item.providerName?.trim() || item.provider,
      models: [],
    };
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
}

function historyField(
  label: string,
  value: string,
  disabled: boolean,
  onInput: (value: string) => void,
  options: {
    type?: string;
    min?: number;
    max?: number;
    placeholder?: string;
    autoComplete?: string;
  } = {},
) {
  return (
    <label className="memos-settings-field">
      <span className="memos-settings-label">{label}</span>
      <input
        className="memos-settings-input"
        type={options.type ?? "text"}
        min={options.min}
        max={options.max}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoComplete={options.autoComplete}
        placeholder={options.placeholder}
        onInput={(event) => onInput(event.currentTarget.value)}
      />
    </label>
  );
}

function historyCheckbox(
  checked: boolean,
  title: string,
  description: string,
  disabled: boolean,
  onChange: (checked: boolean) => void,
) {
  return (
    <label className="memos-settings-check-row">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="memos-settings-check-copy">
        <span className="memos-settings-check-title">{title}</span>
        <span className="memos-settings-muted">{description}</span>
      </span>
    </label>
  );
}

function HistorySettingsCard({
  snapshot,
}: {
  snapshot: SettingsSnapshot;
}) {
  const [history, setHistory] = useState<HistorySnapshot>();
  const [draft, setDraft] = useState<HistoryConfig>();
  const [capability, setCapability] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [capabilityError, setCapabilityError] = useState("");
  const [action, setAction] = useState<"" | "save" | "run" | "status" | "connect">("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const groupedModels = useMemo(
    () => historyModelGroups(snapshot.models),
    [snapshot.models],
  );
  const modelKeys = useMemo(
    () => new Set(snapshot.models.map((item) => modelKey(item.provider, item.model))),
    [snapshot.models],
  );
  const selectedModelKey = historyModelKey(draft?.backgroundModel);
  const selectedModelAvailable = selectedModelKey === MEMORY_ROUTE_VALUE
    || modelKeys.has(selectedModelKey);
  const selectModelValue = draft?.backgroundModel === undefined
    || selectedModelAvailable
    ? selectedModelKey
    : MEMORY_ROUTE_VALUE;
  const savedModelKey = historyModelKey(history?.config.backgroundModel);
  const savedModelAvailable = savedModelKey === MEMORY_ROUTE_VALUE
    || modelKeys.has(savedModelKey);
  const busy = action !== "";
  const dirty = history !== undefined && draft !== undefined
    && !sameHistoryConfig(draft, history.config);
  const remoteStatus = history?.remote;
  const pairingConfigured = history?.config.remote.hasPairingKey === true
    || draft?.remote.hasPairingKey === true;
  const sessionConfigured = history?.config.remote.hasSession === true
    || draft?.remote.hasSession === true;

  const applyHistorySnapshot = (next: HistorySnapshot) => {
    setHistory(next);
    setDraft(historyConfigDraft(next));
  };

  const loadHistory = async () => {
    setCapability("loading");
    setCapabilityError("");
    setError("");
    try {
      const next = await requestJson<HistorySnapshot>(HISTORY_PATH);
      applyHistorySnapshot(next);
      setCapability("ready");
    } catch (cause) {
      const failure = historyFailureOf(cause);
      if (failure.status === 404) {
        setCapability("missing");
      } else {
        setCapability("error");
        setCapabilityError(failure.message);
      }
    }
  };

  useEffect(() => {
    void loadHistory();
  }, []);

  const patchDraft = (patch: Partial<HistoryConfig>) => {
    setDraft((previous) => previous === undefined
      ? previous
      : {
          ...previous,
          ...patch,
          remote: patch.remote ?? previous.remote,
        });
    setMessage("");
    setError("");
  };

  const patchRemote = (patch: Partial<HistoryRemoteConfig>) => {
    setDraft((previous) => previous === undefined
      ? previous
      : {
          ...previous,
          remote: { ...previous.remote, ...patch },
        });
    setMessage("");
    setError("");
  };

  const save = async () => {
    if (draft === undefined || busy || !selectedModelAvailable) return;
    setAction("save");
    setMessage("");
    setError("");
    try {
      const next = await requestJson<HistorySnapshot>(HISTORY_PATH, {
        method: "PUT",
        body: JSON.stringify(buildHistorySavePayload(draft)),
      });
      applyHistorySnapshot(next);
      setCapability("ready");
      setMessage("历史互通设置已保存；启用时会自动开始整理。");
    } catch (cause) {
      const failure = historyFailureOf(cause);
      setError(`保存失败：${failure.message}`);
      if (failure.status === 404) setCapability("missing");
    } finally {
      setAction("");
    }
  };

  const run = async () => {
    if (busy) return;
    setAction("run");
    setMessage("");
    setError("");
    try {
      const next = await requestJson<HistorySnapshot>(HISTORY_RUN_PATH, {
        method: "POST",
      });
      applyHistorySnapshot(next);
      setCapability("ready");
      setMessage("已提交历史整理任务。");
    } catch (cause) {
      const failure = historyFailureOf(cause);
      setError(`运行失败：${failure.message}`);
      if (failure.status === 404) setCapability("missing");
    } finally {
      setAction("");
    }
  };

  const refreshStatus = async () => {
    if (busy) return;
    const configAtStart = history?.config;
    setAction("status");
    setMessage("");
    setError("");
    try {
      const next = await requestJson<HistorySnapshot>(HISTORY_PATH);
      setHistory(next);
      setDraft((previous) =>
        historyDraftAfterStatusRefresh(previous, configAtStart, next));
      setCapability("ready");
      setMessage("运行状态已刷新。");
    } catch (cause) {
      const failure = historyFailureOf(cause);
      setError(`刷新状态失败：${failure.message}`);
      if (failure.status === 404) setCapability("missing");
    } finally {
      setAction("");
    }
  };

  const connect = async () => {
    if (busy) return;
    if (dirty) {
      setMessage("");
      setError("有未保存的改动，请先保存后再测试已保存配置。");
      return;
    }
    if (history?.config.remote.enabled !== true) {
      setMessage("");
      setError("请先启用并保存远端连接配置。");
      return;
    }
    const configAtStart = history.config;
    setAction("connect");
    setMessage("");
    setError("");
    try {
      const next = await requestJson<HistorySnapshot>(HISTORY_CONNECT_PATH, {
        method: "POST",
        body: "{}",
      });
      setHistory(next);
      // The action submits only an empty JSON object, never the unsaved form.
      setDraft((previous) =>
        historyDraftAfterResponse(previous, configAtStart, next));
      setCapability("ready");
      if (next.remote !== undefined && remoteStateFailed(next.remote.state)) {
        setError(remoteConnectionMessage(next.remote));
      } else {
        setMessage(remoteConnectionMessage(next.remote));
      }
    } catch (cause) {
      const failure = historyFailureOf(cause);
      if (failure.status === 404) {
        setError("当前服务端未提供“发现并测试连接”接口。");
      } else {
        setError(`连接测试失败：${failure.message}`);
      }
    } finally {
      setAction("");
    }
  };

  if (capability === "loading" && history === undefined) {
    return (
      <p className="memos-settings-muted">正在检查历史互通能力…</p>
    );
  }
  if (capability === "missing") return null;
  if (capability === "error") {
    return (
      <div className="memos-settings-card" role="alert">
        <h3 className="memos-settings-card-title">无法读取历史互通设置</h3>
        <p className="memos-settings-message" data-tone="error">{capabilityError}</p>
      </div>
    );
  }
  if (history === undefined || draft === undefined) return null;

  const status = history.status;
  return (
    <div className="memos-settings-card">
      <div className="memos-settings-card-head">
        <div>
          <h3 className="memos-settings-card-title">Codex 与 DSH 历史互通</h3>
          <p className="memos-settings-muted">
            只读取本地会话 JSONL，不执行其中的内容。最近窗口限制为 1–30 天。
          </p>
        </div>
        <div className="memos-settings-chip-row">
          <span className="memos-settings-chip" data-tone={draft.enabled ? "good" : "warn"}>
            {draft.enabled ? "已启用" : "未启用"}
          </span>
          {status.running && <span className="memos-settings-chip" data-tone="good">运行中</span>}
          {status.waitingForModel && <span className="memos-settings-chip" data-tone="warn">等待模型</span>}
        </div>
      </div>
      <p className="memos-settings-muted">凭据只写不回显。</p>

      {historyCheckbox(
        draft.enabled,
        "启用历史互通",
        "保存启用后会自动整理，每分钟检查一次；也可手动运行。",
        busy,
        (enabled) => patchDraft({ enabled }),
      )}

      <div className="memos-settings-field-grid">
        {historyField(
          "Codex 历史根目录",
          draft.codexRoot,
          busy,
          (codexRoot) => patchDraft({ codexRoot }),
          { placeholder: "例如 C:\\Users\\name\\.codex\\sessions" },
        )}
        {historyField(
          "DSH 历史根目录",
          draft.dshRoot,
          busy,
          (dshRoot) => patchDraft({ dshRoot }),
          { placeholder: "例如 C:\\Users\\name\\.dsh\\sessions" },
        )}
        {historyField(
          "最近天数",
          String(draft.recentDays),
          busy,
          (recentDays) => patchDraft({
            recentDays: clampRecentDays(Number(recentDays) || 1),
          }),
          { type: "number", min: 1, max: 30 },
        )}
        <label className="memos-settings-field">
          <span className="memos-settings-label">后台整理模型</span>
          <select
            className="memos-settings-select"
            value={selectModelValue}
            disabled={busy}
            onChange={(event) => patchDraft({
              backgroundModel: parseHistoryModelKey(event.currentTarget.value),
            })}
          >
            <option value={MEMORY_ROUTE_VALUE}>使用记忆固定模型（跟随模式下等待）</option>
            {!selectedModelAvailable && (
              <option value={selectedModelKey}>
                当前已保存的模型不在本次目录中
              </option>
            )}
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
      </div>

      <div className="memos-settings-divider" />

      {historyCheckbox(
        draft.remote.enabled,
        "启用 MemOS 联网与设备互联",
        "通过 HTTPS 或已配对的局域网发现连接另一台设备；只同步记忆摘要，不上传原始会话。",
        busy,
        (enabled) => patchRemote({ enabled }),
      )}

      {(remoteStatus !== undefined || draft.remote.enabled) && (
        <div className="memos-settings-readonly">
          <div className="memos-settings-chip-row">
            <span
              className="memos-settings-chip"
              data-tone={remoteStateTone(remoteStatus?.state)}
            >
              {remoteStateLabel(remoteStatus?.state)}
            </span>
            {remoteRouteLabel(remoteStatus?.route) !== "" && (
              <span className="memos-settings-chip">{remoteRouteLabel(remoteStatus?.route)}</span>
            )}
            {syncCount(remoteStatus?.sync) !== undefined && (
              <span className="memos-settings-chip">
                已同步 {syncCount(remoteStatus?.sync)} 条
              </span>
            )}
          </div>
          {(remoteStatus?.nodeId !== undefined || remoteStatus?.url !== undefined) && (
            <span className="memos-settings-route">
              {[remoteStatus.nodeId, remoteStatus.url].filter(Boolean).join(" · ")}
            </span>
          )}
          <span className="memos-settings-muted">
            上次连接 {formatConnectedAt(remoteStatus?.lastConnectedAt)}
          </span>
          {remoteStatus?.lastError !== undefined && remoteStatus.lastError !== "" && (
            <span className="memos-settings-message" data-tone="error" role="status">
              {remoteStatus.lastError}
            </span>
          )}
        </div>
      )}

      <div className="memos-settings-field-grid">
        {historyField(
          "远程 HTTPS 地址（可选）",
          draft.remote.url,
          busy,
          (url) => patchRemote({ url }),
          { type: "url", placeholder: "https://memory.example.com/desktop/api/memory-peer" },
        )}
        {historyField(
          "配对 key（写入后不回显）",
          draft.remote.pairingKey ?? "",
          busy,
          (pairingKey) => patchRemote({ pairingKey }),
          {
            type: "password",
            autoComplete: "new-password",
            placeholder: pairingConfigured ? "已配置；留空保持原值" : "输入配对 key",
          },
        )}
        {historyField(
          "服务器 session（写入后不回显）",
          draft.remote.session ?? "",
          busy,
          (session) => patchRemote({ session }),
          {
            type: "password",
            autoComplete: "new-password",
            placeholder: sessionConfigured ? "已配置；留空保持原值" : "可选：服务器分配 session",
          },
        )}
        {historyField(
          "本机设备标识",
          draft.remote.nodeId ?? "",
          busy,
          (nodeId) => patchRemote({ nodeId }),
          { placeholder: "例如 nanopi-m4v2" },
        )}
        {historyField(
          "期望对端 ID",
          draft.remote.expectedNodeId ?? "",
          busy,
          (expectedNodeId) => patchRemote({ expectedNodeId }),
          { placeholder: "防止连错设备，可留空" },
        )}
        {historyField(
          "服务端口",
          String(draft.remote.peerPort ?? DEFAULT_PEER_PORT),
          busy,
          (peerPort) => patchRemote({ peerPort }),
          { type: "number", min: 1_024, max: 65_535 },
        )}
        {historyField(
          "发现间隔（秒）",
          String(
            draft.remote.pollIntervalSeconds
            ?? DEFAULT_POLL_INTERVAL_SECONDS,
          ),
          busy,
          (pollIntervalSeconds) => patchRemote({ pollIntervalSeconds }),
          { type: "number", min: 15, max: 3_600 },
        )}
      </div>

      <div className="memos-settings-peer-toggle-grid">
        {historyCheckbox(
          draft.remote.lanDiscovery !== false,
          "LAN 自动发现",
          "只接受已完成身份绑定和认证的局域网对端。",
          busy,
          (lanDiscovery) => patchRemote({ lanDiscovery }),
        )}
        {historyCheckbox(
          draft.remote.syncEnabled === true,
          "自动同步记忆",
          "仅同步摘要、结构、来源标识与向量，不复制原始会话。",
          busy,
          (syncEnabled) => patchRemote({ syncEnabled }),
        )}
      </div>

      <p className="memos-settings-note">
        配对 key 与 session 只写入私有 sidecar，保存成功后清空输入且不会回显。
        此页不会启动 SSH；保存时会丢弃旧 tunnelFile 字段。
      </p>

      <details className="memos-settings-details">
        <summary>高级兼容</summary>
        <div className="memos-settings-field-grid">
          {historyField(
            "旧版 Token 文件（JSON，可选）",
            draft.remote.tokenFile,
            busy,
            (tokenFile) => patchRemote({ tokenFile }),
            { placeholder: "C:\\secrets\\memos-token.json" },
          )}
          {historyField(
            "服务器 session 文件（可选）",
            draft.remote.sessionFile ?? "",
            busy,
            (sessionFile) => patchRemote({ sessionFile }),
            { placeholder: "C:\\secrets\\memory-session.json" },
          )}
        </div>
      </details>

      <div className="memos-settings-readonly">
        <span className="memos-settings-label">MCP 只读状态</span>
        <span className="memos-settings-route">
          {history.mcp.enabled ? "已启用" : "未启用"}
          {history.mcp.url ? ` · ${history.mcp.url}` : " · 未提供地址"}
        </span>
        <span className="memos-settings-muted">MCP 状态为只读，不提供凭据输入或编辑。</span>
      </div>

      <div className="memos-settings-chip-row">
        <span className="memos-settings-chip" data-tone={status.running ? "good" : "warn"}>
          {status.running ? "正在运行" : "当前空闲"}
        </span>
        <span className="memos-settings-chip">已导入 {status.imported}</span>
        <span className="memos-settings-chip">已跳过 {status.skipped}</span>
        {!!status.skippedFiles && <span className="memos-settings-chip" data-tone="warn">已跳过文件 {status.skippedFiles}</span>}
        <span className="memos-settings-chip">上次运行 {formatTimestamp(status.lastRunAt)}</span>
        {status.waitingForModel && (
          <span className="memos-settings-chip" data-tone="warn">等待记忆模型</span>
        )}
      </div>
      {status.lastError !== undefined && status.lastError !== "" && (
        <p className="memos-settings-message" data-tone="warn">{status.lastError}</p>
      )}
      {status.lastWarning && <p className="memos-settings-message" data-tone="warn">{status.lastWarning}</p>}

      {error !== "" && (
        <p className="memos-settings-message" data-tone="error" role="alert">{error}</p>
      )}
      {message !== "" && (
        <p className="memos-settings-message" data-tone="success" role="status" aria-live="polite">
          {message}
        </p>
      )}

      <div className="memos-settings-actions">
        <button
          type="button"
          className="memos-settings-button"
          disabled={busy}
          onClick={() => void refreshStatus()}
        >
          {action === "status" ? "刷新中…" : "刷新状态"}
        </button>
        {dirty && (
          <span className="memos-settings-message" data-tone="warn">
            有未保存改动；测试前请先保存
          </span>
        )}
        <button
          type="button"
          className="memos-settings-button"
          disabled={busy}
          title={dirty
            ? "请先保存未提交的改动，再测试已保存配置"
            : "使用已保存的配置发现并测试连接"}
          onClick={() => void connect()}
        >
          {action === "connect" ? "测试中…" : "发现并测试连接"}
        </button>
        <button
          type="button"
          className="memos-settings-button"
          disabled={busy || history.config.enabled !== true || !savedModelAvailable}
          onClick={() => void run()}
        >
          {action === "run" ? "运行中…" : "运行一次"}
        </button>
        <button
          type="button"
          className="memos-settings-button"
          data-primary="true"
          disabled={busy || !dirty || !selectedModelAvailable}
          onClick={() => void save()}
        >
          {action === "save" ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
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

          <HistorySettingsCard snapshot={snapshot} />
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
