/** Mirrors worker/src/profiles.ts — client-side checks only; server is source of truth. */
const HANDLE_MIN = 3;
const HANDLE_MAX = 24;
const HANDLE_RE = /^[a-z][a-z0-9]{2,23}$/;

export function normalizeHandleInput(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, HANDLE_MAX);
}

export function handleInputError(value: string): string | null {
  if (!value) return 'Handle is required';
  if (value.length < HANDLE_MIN || value.length > HANDLE_MAX) {
    return `Handle must be ${HANDLE_MIN}–${HANDLE_MAX} characters`;
  }
  if (!HANDLE_RE.test(value)) {
    return 'Handle must start with a letter and use only lowercase letters and numbers';
  }
  return null;
}
