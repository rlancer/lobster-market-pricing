// Symbology / security-identity helpers (shared by the backfill job, the
// figi_map tool, and the OHLC/corporate-action publish path).
//
// The lake's security master (`options.securities`) keys on a stable
// `security_id` that is meant to outlive ticker renames (FB -> META). We do
// not have a live OpenFIGI lookup available inside the scheduler DO, so the
// default identity is a DETERMINISTIC UUID derived from the ticker. That keeps
// every writer (figi_map publishing securities/symbol_history, the backfill
// job seeding its item store, the OHLC path emitting corporate_actions)
// projecting the SAME security_id for the SAME ticker — no cross-service state
// needed. Rename continuity is expressed through `options.symbol_history`
// rows (an old ticker row points at the canonical current ticker's
// security_id), not by mutating security_id.
//
// Deliberately dependency-free (runs in the Workers runtime AND in Node tools):
// the UUID is a deterministic 128-bit FNV-1a digest of the seed, formatted as a
// canonical lowercase UUID.

// Two independent 64-bit FNV-1a offsets (constants from the FNV-1a spec) so the
// low/high halves of the digest differ.
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

// Deterministic 128-bit digest (2 × FNV-1a over the seed) → 32 hex chars.
function digest128(seed: string): string {
  const hi = fnv1a64(seed, FNV1A_OFFSET_HI);
  const lo = fnv1a64(seed + ":" + OFFSET_BASIS.toString(16), FNV1A_OFFSET_LO);
  const hex = (hi.toString(16).padStart(16, "0") + lo.toString(16).padStart(16, "0")).toLowerCase();
  return hex;
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

// Format a seed as a canonical (lowercase) UUID. Deterministic for a given
// seed, so two processes compute the same id.
export function uuidFromSeed(seed: string): string {
  return formatUuid(digest128(seed));
}

// Stable security id for a current ticker. Primary default when no OpenFIGI
// composite mapping is available.
export function securityIdForTicker(ticker: string): string {
  return uuidFromSeed(`ticker:${ticker.toUpperCase()}`);
}

// Prefer the OpenFIGI composite FIGI when present (stable across a rename),
// else fall back to the ticker-derived id. Used by figi_map so a security
// that renames keeps ONE id across both tickers.
export function securityIdForFigi(compositeFigi: string | null | undefined, ticker: string): string {
  if (compositeFigi) return uuidFromSeed(`figi:${compositeFigi.toUpperCase()}`);
  return securityIdForTicker(ticker);
}

// A compact 64-bit hex digest, used for rename-join hashing in figi_map.
export function fingerprint64(seed: string): string {
  return fnv1a64(seed, FNV1A_OFFSET_HI).toString(16).padStart(16, "0");
}
