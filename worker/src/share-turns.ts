/**
 * Flatten AI SDK UIMessage parts into share/timeline turns.
 */
import type { UIMessage } from "ai";

export type ShareTurn = {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  sql?: string;
  ts?: number;
};

/** Flatten UIMessage parts into share/timeline turns (text + optional reasoning/sql). */
export function extractShareTurns(messages: UIMessage[]): ShareTurn[] {
  const out: ShareTurn[] = [];
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
    for (const part of message.parts) {
      if (!("output" in part) || !part.output || typeof part.output !== "object") continue;
      const output = part.output as { sql?: unknown };
      if (typeof output.sql === "string" && output.sql.trim()) {
        sql = output.sql.trim();
        break;
      }
    }
    const meta = message.metadata as { createdAt?: number; sql?: string } | undefined;
    if (!sql && typeof meta?.sql === "string" && meta.sql.trim()) sql = meta.sql.trim();
    if (!content && !reasoning) continue;
    const turn: ShareTurn = {
      role: message.role,
      content: content || (reasoning ? "(see reasoning)" : ""),
    };
    if (reasoning) turn.reasoning = reasoning;
    if (sql) turn.sql = sql;
    if (typeof meta?.createdAt === "number" && Number.isFinite(meta.createdAt)) turn.ts = meta.createdAt;
    out.push(turn);
  }
  return out;
}
