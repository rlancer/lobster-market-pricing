/** Keep in sync with worker `isDeskStubText` (share wnJWqa protocol echo). */
const STUB_RE = /^(placeholder|tbd|todo|n\/?a|none|null|undefined|\.{1,3}|x+|-+)$/i;

export function isDeskStubText(text: string): boolean {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return true;
  if (STUB_RE.test(trimmed)) return true;
  if (/\breceived\b/i.test(trimmed) && /first include(?: the)? text/i.test(trimmed)) return true;
  if (/^received:\s*\.{2,}/i.test(trimmed)) return true;
  return false;
}
