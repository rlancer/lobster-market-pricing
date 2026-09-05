import { useNavigate, useSearch } from '@tanstack/react-router';
import { isHistoricalAsOf, parseAsOfDate } from './asOfDate';
import { etDateString } from './tickerChartRange';

export function useAsOfDate(): {
  asOf: string | undefined;
  asOfDate: string;
  historical: boolean;
  setAsOf: (next: string | undefined) => void;
} {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { asof?: unknown };
  const today = etDateString();
  const asOf = parseAsOfDate(
    typeof search.asof === 'string' ? search.asof : undefined,
    today,
  ) ?? undefined;
  const historical = isHistoricalAsOf(asOf, today);

  const setAsOf = (next: string | undefined) => {
    const parsed = parseAsOfDate(next, today) ?? undefined;
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const nextSearch = { ...prev };
        if (parsed) nextSearch.asof = parsed;
        else delete nextSearch.asof;
        return nextSearch;
      },
      replace: true,
    });
  };

  return { asOf, asOfDate: asOf ?? today, historical, setAsOf };
}
