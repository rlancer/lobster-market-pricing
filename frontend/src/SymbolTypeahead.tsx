import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, type SymbolSuggestion } from './api';
import './SymbolTypeahead.css';

interface Props {
  value: string;
  onSelect: (symbol: string) => void;
  onChange: (raw: string) => void;
  liquidOnly?: boolean;
}

export default function SymbolTypeahead({ value, onSelect, onChange, liquidOnly }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SymbolSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // debounced search
  const search = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await api.symbols(q, liquidOnly);
      setItems(res);
      setActive(res.length ? 0 : -1);
    } catch {
      setItems([]);
      setActive(-1);
    } finally {
      setLoading(false);
    }
  }, [liquidOnly]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => search(value), 150);
    return () => clearTimeout(t);
  }, [value, open, search]);

  // close on outside click / blur
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const choose = (s: SymbolSuggestion) => {
    onSelect(s.symbol);
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && items[active]) {
        e.preventDefault();
        choose(items[active]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="typeahead" ref={wrapRef}>
      <input
        ref={inputRef}
        className="typeahead-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        value={value}
        placeholder="Search ticker or name…"
        onChange={(e) => { onChange(e.target.value.toUpperCase()); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id={listId} className="typeahead-list" role="listbox">
          {loading && <li className="typeahead-loading">Searching…</li>}
          {!loading && items.length === 0 && value.trim() !== '' && (
            <li className="typeahead-empty">No matches for “{value}”</li>
          )}
          {!loading && items.map((s, i) => (
            <li
              key={s.symbol}
              role="option"
              aria-selected={i === active}
              className={`typeahead-item${i === active ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); choose(s); }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="t-sym">{s.symbol}</span>
              <span className="t-name">{s.name ?? '–'}</span>
              {s.sector && <span className="t-sector">{s.sector}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
