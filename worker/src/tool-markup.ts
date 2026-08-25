/**
 * Detect / strip model-leaked tool-call markup that never became a real tool part.
 * DeepSeek DSML (and similar XML tool envelopes) sometimes lands in the
 * visible text channel — leaving "Let me render…" + raw invoke XML as the
 * share body (e.g. share VMJqmdt9ldnIcTvFpn37NRlj).
 */
import { looksLikeDsmlToolMarkup, stripDsmlToolMarkup } from "./dsml";

const GENERIC_TOOL_BLOCK =
  /<\/?(?:tool_calls|function_calls|tool_call|function_call)\b[^>]*>[\s\S]*?<\/(?:tool_calls|function_calls|tool_call|function_call)>/gi;

const LEAKED_MARKUP_RE =
  /(?:DSML\s*(?:tool_calls|invoke|parameter)|<\/?(?:tool_calls|function_calls|tool_call)\b|<\|?(?:DSML)\|?|｜DSML｜)/i;

/** Strip leaked tool-call markup from assistant text. */
export function stripLeakedToolMarkup(text: string): string {
  if (!text) return text;
  let out = looksLikeDsmlToolMarkup(text) ? stripDsmlToolMarkup(text) : text;
  out = out.replace(GENERIC_TOOL_BLOCK, "");
  // Orphan DSML tags that survived an incomplete strip (byte-capped mid-block).
  out = out.replace(/<\/?(?:\|?｜?)DSML(?:\|?｜?)[^>\n]*>/gi, "");
  out = out.replace(/<\/?｜DSML｜[^>\n]*>/g, "");
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** True when assistant text still contains leaked tool-call markup. */
export function hasLeakedToolMarkup(text: string): boolean {
  if (!text) return false;
  return LEAKED_MARKUP_RE.test(text);
}
