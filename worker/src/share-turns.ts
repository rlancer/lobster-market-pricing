/**
 * Flatten AI SDK UIMessage parts into share/timeline turns.
 */
import type { UIMessage } from "ai";
import { chartFitsResult, inferChartSpec, wantsChart, type ChartSpec } from "./chart-spec";
import { normalizeDeskBrief, type DeskBrief } from "./copilot-desk";

export type ShareTurn = {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  sql?: string;
  chart?: ChartSpec;
  desk?: DeskBrief;
  ts?: number;
};

export type ShareCapture = {
  sql?: string | null;
  result?: { columns?: string[]; rows?: Record<string, unknown>[]; error?: string } | null;
  chart?: ChartSpec | null;
};

type ToolPayload = {
  sql?: unknown;
  result?: { columns?: unknown; rows?: unknown } | null;
  chart?: unknown;
  desk?: unknown;
};

function asChartSpec(value: unknown): ChartSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const kind = rec.kind;
  if (kind !== "line" && kind !== "area" && kind !== "scatter" && kind !== "bar") return null;
  if (typeof rec.x !== "string" || !rec.x.trim()) return null;
  if (typeof rec.y !== "string" || !rec.y.trim()) return null;
  const chart: ChartSpec = { kind, x: rec.x.trim(), y: rec.y.trim() };
  if (typeof rec.title === "string" && rec.title.trim()) chart.title = rec.title.trim();
  if (typeof rec.series === "string" && rec.series.trim()) chart.series = rec.series.trim();
  if (typeof rec.xLabel === "string" && rec.xLabel.trim()) chart.xLabel = rec.xLabel.trim();
  if (typeof rec.yLabel === "string" && rec.yLabel.trim()) chart.yLabel = rec.yLabel.trim();
  return chart;
}

function asQueryResult(value: unknown): { columns: string[]; rows: Record<string, unknown>[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as { columns?: unknown; rows?: unknown; error?: unknown };
  if (typeof rec.error === "string" && rec.error.trim()) return null;
  if (!Array.isArray(rec.columns) || !rec.columns.every((c) => typeof c === "string")) return null;
  if (!Array.isArray(rec.rows)) return null;
  return {
    columns: rec.columns as string[],
    rows: rec.rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)),
  };
}

function toolPartName(part: { type?: unknown }): string {
  if (typeof part.type !== "string") return "";
  // AI SDK tool UI parts: "tool-render_chart" / "dynamic-tool" with toolName.
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return part.type;
}

/**
 * Stamp the last assistant turn with the DO turn-budget capture.
 * Message parts sometimes omit tool outputs after headless runs; capture_json
 * is the authoritative sql/result/chart from the completed turn.
 */
export function applyCaptureToShareTurns(
  turns: ShareTurn[],
  capture: ShareCapture | null | undefined,
  question = "",
): ShareTurn[] {
  if (!capture || !turns.length) return turns;
  const out = turns.map((turn) => ({ ...turn }));
  let assistantIdx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "assistant") {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx < 0) return out;
  const turn = out[assistantIdx];
  const captureSql = typeof capture.sql === "string" && capture.sql.trim() ? capture.sql.trim() : null;
  if (captureSql) turn.sql = captureSql;
  let chart = turn.chart ?? asChartSpec(capture.chart);
  const result = asQueryResult(capture.result);
  if (chart && result && !chartFitsResult(chart, result.columns)) chart = null;
  if (!chart && result && wantsChart(question)) {
    chart = inferChartSpec(result.columns, result.rows);
  }
  if (chart) turn.chart = chart;
  out[assistantIdx] = turn;
  return out;
}

/** Flatten UIMessage parts into share/timeline turns (text + optional reasoning/sql/chart). */
export function extractShareTurns(messages: UIMessage[]): ShareTurn[] {
  const out: ShareTurn[] = [];
  let lastUserQuestion = "";
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof (part as { text?: string }).text === "string")
      .map((part) => part.text)
      .join("")
      .trim();
    const reasoning = message.parts
      .filter((part): part is { type: "reasoning"; text: string } => part.type === "reasoning" && typeof (part as { text?: string }).text === "string")
      .map((part) => part.text)
      .join("")
      .trim();

    let sql: string | undefined;
    let chart: ChartSpec | null = null;
    let result: { columns: string[]; rows: Record<string, unknown>[] } | null = null;
    let desk: DeskBrief | null = null;
    for (const part of message.parts) {
      const name = toolPartName(part as { type?: unknown });
      const input = "input" in part ? (part as { input?: unknown }).input : undefined;
      // render_chart args are themselves a ChartSpec — keep them even when output was stripped.
      if (name === "render_chart") {
        const fromInput = asChartSpec(input);
        if (fromInput) chart = fromInput;
      }
      if (name === "publish_desk" && input && typeof input === "object") {
        const fromInput = normalizeDeskBrief(input as {
          fundamental: string;
          technical: string;
          options: string;
          overview: string;
        });
        if (fromInput) desk = fromInput;
      }
      if (!("output" in part) || !part.output || typeof part.output !== "object") continue;
      const output = part.output as ToolPayload;
      if (typeof output.sql === "string" && output.sql.trim()) sql = output.sql.trim();
      const nextResult = asQueryResult(output.result);
      if (nextResult) {
        result = nextResult;
        if (chart && !chartFitsResult(chart, result.columns)) chart = null;
      }
      const nextChart = asChartSpec(output.chart) ?? (name === "render_chart" ? asChartSpec(input) : null);
      if (nextChart) {
        chart = nextChart;
        if (result && !chartFitsResult(chart, result.columns)) chart = null;
      }
      if (output.desk && typeof output.desk === "object") {
        const fromOutput = normalizeDeskBrief(output.desk as {
          fundamental: string;
          technical: string;
          options: string;
          overview: string;
        });
        if (fromOutput) desk = fromOutput;
      }
    }

    const meta = message.metadata as {
      createdAt?: number;
      sql?: string;
      chart?: unknown;
    } | undefined;
    if (!sql && typeof meta?.sql === "string" && meta.sql.trim()) sql = meta.sql.trim();
    if (!chart) {
      const metaChart = asChartSpec(meta?.chart);
      if (metaChart && (!result || chartFitsResult(metaChart, result.columns))) chart = metaChart;
    }

    // Live chat falls back to inferChartSpec when the model skips render_chart;
    // mirror that for headless bot shares so timeline posts keep a figure.
    if (!chart && result && wantsChart(lastUserQuestion)) {
      chart = inferChartSpec(result.columns, result.rows);
    }

    if (message.role === "user" && content) lastUserQuestion = content;
    if (!content && !reasoning) continue;
    const turn: ShareTurn = {
      role: message.role,
      content: content || (reasoning ? "(see reasoning)" : ""),
    };
    if (reasoning) turn.reasoning = reasoning;
    if (sql) turn.sql = sql;
    if (chart) turn.chart = chart;
    if (desk) turn.desk = desk;
    if (typeof meta?.createdAt === "number" && Number.isFinite(meta.createdAt)) turn.ts = meta.createdAt;
    out.push(turn);
  }
  return out;
}
