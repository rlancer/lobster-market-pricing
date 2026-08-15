/**
 * Deterministic security_id helpers — keep in lockstep with
 * `loader/src/symbology.ts`. The lake keys securities on these UUIDs; the
 * Worker uses the same seeds so chat/research rows join cleanly to
 * `options.securities` / `options.symbol_history`.
 */

const FNV1A_OFFSET_HI = 0xcbf29ce484222325n;
const FNV1A_OFFSET_LO = 0x84222325cbf29ce4n;
const FNV1A_PRIME = 0x100000001b3n;
const OFFSET_BASIS = 0xcbf29ce484222325n;
const MASK = 0xffffffffffffffffn;

function fnv1a64(input: string, offset: bigint): bigint {
  let hash = offset;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV1A_PRIME) & MASK;
  }
  return hash;
}

function digest128(seed: string): string {
  const hi = fnv1a64(seed, FNV1A_OFFSET_HI);
  const lo = fnv1a64(seed + ":" + OFFSET_BASIS.toString(16), FNV1A_OFFSET_LO);
  return (hi.toString(16).padStart(16, "0") + lo.toString(16).padStart(16, "0")).toLowerCase();
}

function formatUuid(hex32: string): string {
  const s = (i: number): string => hex32[i] ?? "0";
  return (
    s(0) + s(1) + s(2) + s(3) + s(4) + s(5) + s(6) + s(7) + "-" +
    s(8) + s(9) + s(10) + s(11) + "-" +
    "4" + s(13) + s(14) + s(15) + "-" +
    "8" + s(17) + s(18) + s(19) + "-" +
    s(20) + s(21) + s(22) + s(23) + s(24) + s(25) + s(26) + s(27) +
    s(28) + s(29) + s(30) + s(31)
  );
}

export function uuidFromSeed(seed: string): string {
  return formatUuid(digest128(seed));
}

/** Stable security id for a current ticker (primary lake identity). */
export function securityIdForTicker(ticker: string): string {
  return uuidFromSeed(`ticker:${ticker.toUpperCase()}`);
}

/** Prefer composite FIGI when present; else ticker-derived id. */
export function securityIdForFigi(compositeFigi: string | null | undefined, ticker: string): string {
  if (compositeFigi) return uuidFromSeed(`figi:${compositeFigi.toUpperCase()}`);
  return securityIdForTicker(ticker);
}

/** Normalize a free-form symbol to uppercase exchange form (BRK.B stays). */
export function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s]+/g, "");
}
