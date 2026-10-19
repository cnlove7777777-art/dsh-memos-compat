import { useMemo } from "preact/hooks";
import { Icon } from "./Icon";
import { formatActivityTime, formatActivityDuration } from "./dsh-activity-format";
import type { DshActivitySnapshot } from "./dsh-activity-types";

export type { DshActivitySnapshot } from "./dsh-activity-types";

/** Read-only activity history shared by the Viewer settings and history cards. */
export function DshActivityPanel({
  activity,
}: {
  activity: DshActivitySnapshot | null | undefined;
}) {
  const averageMs = useMemo(() => {
    const successes = activity?.totals.model.successes ?? 0;
    return successes > 0
      ? Math.round((activity?.totals.model.totalDurationMs ?? 0) / successes)
      : undefined;
  }, [activity]);

  if (!activity) return null;
  const total = activity.totals;
  const session = activity.session;
  return (
    <div
      class="card card--flat"
      style="margin-top:var(--sp-4);border-left:3px solid var(--info)"
      aria-labelledby="dsh-activity-title"
    >
      <div class="card__header">
        <div>
          <h3 id="dsh-activity-title" class="card__title">
            活动记录
          </h3>
          <p class="card__subtitle" style="margin-bottom:0">
            从 {formatActivityTime(activity.trackingSince)} 开始记录；以下累计仅统计本设备。
          </p>
        </div>
        <span
          class={`pill ${
            activity.persistence.status === "ready" ? "pill--active" : "pill--failed"
          }`}
        >
          {activity.persistence.status === "ready" ? "记录已保存" : "记录保存异常"}
        </span>
      </div>

      <div
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:var(--sp-3)"
      >
        <ActivityMetric
          label="同步尝试"
          value={`${session.sync.attempts} 本次 / ${total.sync.attempts} 本设备累计`}
          note={`成功 ${total.sync.successes} · 失败 ${total.sync.failures}`}
          accent={total.sync.failures > 0}
        />
        <ActivityMetric
          label="同步收发"
          value={`已发送 ${session.sync.sentItems} / 已接收 ${session.sync.receivedItems}`}
          note={`本设备累计已发送 ${total.sync.sentItems} · 已接收 ${total.sync.receivedItems}；以本机成功处理为准`}
        />
        <ActivityMetric
          label="文字模型请求"
          value={`${session.model.requests} 本次 / ${total.model.requests} 本设备累计`}
          note={`成功 ${total.model.successes} · 失败 ${total.model.failures}${
            total.model.pending ? ` · 进行中 ${total.model.pending}` : ""
          }`}
          accent={total.model.failures > 0}
        />
        <ActivityMetric
          label="平均成功耗时"
          value={averageMs === undefined ? "—" : formatActivityDuration(averageMs)}
          note={`模型服务内部的重试不单独计数`}
        />
      </div>

      <details style="margin-top:var(--sp-4)">
        <summary style="cursor:pointer;font-size:var(--fs-sm)">
          最近同步（{activity.recentSync.length} 条，最多保留 64 条）
        </summary>
        {activity.recentSync.length === 0 ? (
          <p class="muted" style="font-size:var(--fs-xs);margin:6px 0 0">
            尚无同步记录。
          </p>
        ) : (
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:var(--sp-2)">
            {activity.recentSync.slice().reverse().map((row) => (
              <ActivityRow
                key={row.id}
                tone={row.outcome}
                title={syncOperationLabel(row.operation)}
                meta={[
                  formatActivityTime(row.at),
                  activityRouteLabel(row.route),
                  row.peer,
                ].filter(Boolean).join(" · ")}
                detail={syncActivityDetail(row)}
                errorCode={row.errorCode}
              />
            ))}
          </div>
        )}
      </details>

      <details style="margin-top:var(--sp-4)">
        <summary style="cursor:pointer;font-size:var(--fs-sm)">最近文字模型请求（{activity.recentModels.length}）</summary>
        {activity.recentModels.length === 0 ? (
          <p class="muted" style="font-size:var(--fs-xs);margin:6px 0 0">
            尚无模型请求记录。
          </p>
        ) : (
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:var(--sp-2)">
            {activity.recentModels.slice().reverse().map((row) => (
              <ActivityRow
                key={row.id}
                tone={row.outcome === "success" ? "success" : row.outcome === "pending" ? "pending" : "failure"}
                title={`${modelOperationLabel(row.operation)} · ${row.provider}/${row.model}`}
                meta={[
                  formatActivityTime(row.at),
                  row.outcome === "success"
                    ? formatActivityDuration(row.durationMs)
                    : activityOutcomeLabel(row.outcome),
                ].filter(Boolean).join(" · ")}
                detail="记忆插件发起的文字模型请求"
                errorCode={row.errorCode}
              />
            ))}
          </div>
        )}
      </details>

      <details style="margin-top:var(--sp-4)">
        <summary style="cursor:pointer;font-size:var(--fs-sm)">
          最近历史整理摘要（{total.summaries} 本设备累计）
        </summary>
        {activity.recentSummaries.length === 0 ? (
          <p class="muted" style="font-size:var(--fs-xs);margin:6px 0 0">
            尚无成功生成并写入记忆库的摘要。
          </p>
        ) : (
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:var(--sp-2)">
            {activity.recentSummaries.slice().reverse().map((row) => (
              <ActivityRow
                key={row.id}
                tone="success"
                title={`${row.source === "codex" ? "Codex" : "DSH"} · ${row.provider}/${row.model}`}
                meta={formatActivityTime(row.at)}
                detail={row.summary}
              />
            ))}
          </div>
        )}
      </details>

      <div
        class="muted"
        style="margin-top:var(--sp-3);font-size:var(--fs-xs);line-height:1.6"
      >
        统计记忆插件发起的文字模型请求，模型服务内部的重试不单独计数。
        每次收发同步页分别计数；发送记录以本机成功处理为准。
        仅保留简短摘要，不保存完整对话或登录凭据。向量模型状态单独显示。
      </div>
      {activity.persistence.warning && (
        <p
          role="status"
          style="margin:8px 0 0;font-size:var(--fs-xs);color:var(--warning)"
        >
          部分活动记录未能保存，请检查存储状态。错误代码：{activity.persistence.warning}
        </p>
      )}
    </div>
  );
}
function ActivityMetric({
  label,
  value,
  note,
  accent,
}: {
  label: string;
  value: string;
  note: string;
  accent?: boolean;
}) {
  return (
    <div
      style={`padding:var(--sp-3);border:1px solid var(--border);border-radius:var(--radius-md);background:${
        accent ? "var(--warning-soft)" : "var(--bg-canvas)"
      }`}
    >
      <div class="muted" style="font-size:var(--fs-xs)">{label}</div>
      <div style="font-size:var(--fs-lg);font-weight:var(--fw-semi);margin-top:3px">
        {value}
      </div>
      <div class="muted" style="font-size:var(--fs-xs);line-height:1.5;margin-top:3px">
        {note}
      </div>
    </div>
  );
}

function ActivityRow({
  tone,
  title,
  meta,
  detail,
  errorCode,
}: {
  tone: "success" | "failure" | "pending";
  title: string;
  meta: string;
  detail: string;
  errorCode?: string;
}) {
  return (
    <div
      style="display:grid;grid-template-columns:18px minmax(0,1fr);gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-canvas)"
    >
      <Icon
        name={tone === "success" ? "check-circle-2" : tone === "pending" ? "clock" : "circle-alert"}
        size={15}
        style={`margin-top:2px;color:${tone === "success" ? "var(--success)" : tone === "pending" ? "var(--info)" : "var(--danger)"}`}
      />
      <div style="min-width:0">
        <div class="hstack" style="justify-content:space-between;gap:var(--sp-2);flex-wrap:wrap">
          <strong style="font-size:var(--fs-xs)">{title}</strong>
          <span class="muted" style="font-size:var(--fs-xs)">{meta}</span>
        </div>
        <div style="font-size:var(--fs-xs);line-height:1.55;overflow-wrap:anywhere;margin-top:2px">
          {detail}
        </div>
        {errorCode && (
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--danger);margin-top:3px">
            {errorCode}
          </div>
        )}
      </div>
    </div>
  );
}

function syncActivityDetail(row: DshActivitySnapshot["recentSync"][number]): string {
  const transferred = row.direction === "send"
    ? `发送 ${row.sentItems} 条`
    : `接收 ${row.receivedItems} 条`;
  return [
    transferred,
    `新增 ${row.inserted}`,
    `更新 ${row.updated}`,
    `未变 ${row.skipped}`,
  ].join(" · ");
}

function syncOperationLabel(value: DshActivitySnapshot["recentSync"][number]["operation"]): string {
  return {
    pull: "向对端拉取",
    push: "向对端发送",
    serve_pull: "本机向对端提供",
    receive_push: "本机接收对端发送",
  }[value];
}

function activityRouteLabel(value: DshActivitySnapshot["recentSync"][number]["route"]): string {
  return {
    lan: "局域网直连",
    wan: "公网 HTTPS",
    relay: "反向中继",
    gateway: "认证网关",
  }[value];
}

function modelOperationLabel(value: string): string {
  return {
    "memory.core_text": "记忆文字模型",
    "history.refine": "历史整理",
    "settings.model_test": "模型连接测试",
  }[value] || value;
}

function activityOutcomeLabel(value: string): string {
  return {
    failure: "失败",
    pending: "进行中",
    interrupted: "重启时中断",
  }[value] || value;
}
