import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HIDE_DOLLARS_STORAGE_KEY,
  loadHideDollars,
  saveHideDollars,
} from './hideDollars.ts';

function installMemoryStorage() {
  const store = new Map<string, string>();
  const memory = {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: memory,
  });
  return store;
}

test('hide-dollars preference reads and writes localStorage', () => {
  const store = installMemoryStorage();
  assert.equal(loadHideDollars(), false);
  assert.equal(saveHideDollars(true), true);
  assert.equal(store.get(HIDE_DOLLARS_STORAGE_KEY), '1');
  assert.equal(loadHideDollars(), true);
  assert.equal(saveHideDollars(false), false);
  assert.equal(loadHideDollars(), false);
});
