import { useMemo, type ReactNode } from 'react';
import {
  Typeahead,
  TypeaheadItem,
  type SearchableItem,
  type SearchSource,
  type TypeaheadSize,
} from '@astryxdesign/core/Typeahead';
import type { IconType } from '@astryxdesign/core/Icon';
import { searchSymbols } from './symbolCache';

export type TickerItem = SearchableItem<{
  name: string | null;
  sector: string | null;
}>;

const BOOTSTRAP = ['AAPL', 'NVDA', 'SPY', 'TSLA', 'MSFT', 'AMZN', 'META', 'GOOGL'];

function toItem(symbol: string, name: string | null = null, sector: string | null = null): TickerItem {
  return {
    id: symbol.toUpperCase(),
    label: symbol.toUpperCase(),
    auxiliaryData: { name, sector },
  };
}

function createSymbolSource(): SearchSource<TickerItem> {
  return {
    async search(query: string) {
      const rows = await searchSymbols(query);
      return rows.map((s) => toItem(s.symbol, s.name, s.sector));
    },
    async bootstrap() {
      try {
        const rows = await searchSymbols('');
        const bySym = new Map(rows.map((s) => [s.symbol.toUpperCase(), s]));
        const preferred = BOOTSTRAP
          .map((sym) => bySym.get(sym))
          .filter((s): s is NonNullable<typeof s> => Boolean(s))
          .map((s) => toItem(s.symbol, s.name, s.sector));
        if (preferred.length > 0) return preferred;
        return rows.slice(0, 8).map((s) => toItem(s.symbol, s.name, s.sector));
      } catch {
        return BOOTSTRAP.map((sym) => toItem(sym));
      }
    },
  };
}

export function TickerTypeahead({
  value,
  onSelect,
  onClear,
  onChangeQuery,
  width = '100%',
  size = 'md',
  isLabelHidden = false,
  startIcon,
  className,
}: {
  /** Currently open ticker, if any. */
  value: string | null;
  /** Navigate when the user picks a suggestion. */
  onSelect: (symbol: string) => void;
  /** Called when the clear control empties the field. */
  onClear?: () => void;
  /** Track free-typed query (for Open / Enter on unknown tickers). */
  onChangeQuery?: (query: string) => void;
  width?: number | string;
  size?: TypeaheadSize;
  isLabelHidden?: boolean;
  startIcon?: ReactNode | IconType;
  className?: string;
}) {
  const searchSource = useMemo(() => createSymbolSource(), []);
  const selected = useMemo(
    () => (value ? toItem(value) : null),
    [value],
  );

  return (
    <Typeahead
      className={className}
      label="Ticker"
      isLabelHidden={isLabelHidden}
      size={size}
      startIcon={startIcon}
      searchSource={searchSource}
      value={selected}
      onChange={(item) => {
        if (item) onSelect(item.id);
        else onClear?.();
      }}
      onChangeQuery={onChangeQuery}
      placeholder="Search ticker or name…"
      hasEntriesOnFocus
      maxMenuItems={10}
      width={width}
      emptySearchResultsText="No matching tickers"
      renderItem={(item) => (
        <TypeaheadItem
          item={item}
          description={
            [item.auxiliaryData?.name, item.auxiliaryData?.sector]
              .filter(Boolean)
              .join(' · ') || undefined
          }
        />
      )}
    />
  );
}
