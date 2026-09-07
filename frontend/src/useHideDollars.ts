import { useCallback, useState } from 'react';
import { loadHideDollars, saveHideDollars } from './hideDollars';

/**
 * Schwab screenshot preference: hide cash/dollar figures and show percents.
 * Browser-local so a share session stays on without an account setting.
 */
export function useHideDollars(): {
  hideDollars: boolean;
  setHideDollars: (next: boolean) => void;
} {
  const [hideDollars, setHideDollarsState] = useState(loadHideDollars);
  const setHideDollars = useCallback((next: boolean) => {
    setHideDollarsState(saveHideDollars(next));
  }, []);
  return { hideDollars, setHideDollars };
}
