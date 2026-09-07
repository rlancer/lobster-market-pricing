export const HIDE_DOLLARS_STORAGE_KEY = 'lobster.schwab.hideDollars';

export function loadHideDollars(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(HIDE_DOLLARS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveHideDollars(next: boolean): boolean {
  if (typeof localStorage === 'undefined') return next;
  try {
    localStorage.setItem(HIDE_DOLLARS_STORAGE_KEY, next ? '1' : '0');
  } catch {
    /* private mode / quota */
  }
  return next;
}
