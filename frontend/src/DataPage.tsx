import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  Button,
  Heading,
  HStack,
  List,
  ListItem,
  MetadataList,
  MetadataListItem,
  Text,
  TextInput,
  Tooltip,
  VStack,
} from '@astryxdesign/core';
import './DataPage.css';
import {
  api,
  type EconCalendarResponse,
  type NewsResponse,
  type QueryResult,
  type TableInfo,
  type WebSearchResponse,
} from './api';
import {
  FEEDS,
  OVERVIEW,
  OVERVIEW_ID,
  QUERY,
  QUERY_ID,
  TOOLS,
  catalogItem,
  itemMatches,
  tableItem,
  type CatalogItem,
} from './dataCatalog';

const TABLE_PREVIEW_LIMIT = 250;

const SAMPLES = [
  'SELECT ticker AS symbol, name, sector, spot_price FROM options.underlying_snapshots LIMIT 50',
  'SELECT symbol, COUNT(*) AS contracts, MAX(expiration) AS latest_expiry\nFROM options.option_contracts\nGROUP BY 1\nORDER BY contracts DESC\nLIMIT 20',
  'SELECT sector, COUNT(*) AS symbols, ROUND(AVG(spot_price), 2) AS avg_spot\nFROM options.underlying_snapshots\nGROUP BY sector\nORDER BY symbols DESC',
  'SELECT type, COUNT(*) AS n, ROUND(AVG(implied_vol), 4) AS avg_iv,\n         ROUND(AVG(volume), 0) AS avg_vol\nFROM options.option_contracts\nGROUP BY type',
  'SELECT symbol, expiration, type, strike, bid, ask, volume, implied_vol, delta\nFROM options.option_contracts\nWHERE volume > 0\nORDER BY volume DESC\nLIMIT 100',
];

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v.toLocaleString();
    return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return String(v);
}

function kindLabel(kind: CatalogItem['kind']): string {
  if (kind === 'tool') return 'Chat tool';
  if (kind === 'feed') return 'Feed';
  if (kind === 'table') return 'Lake table';
  if (kind === 'query') return 'SQL';
  return 'Catalog';
}

export default function DataPage() {
  const navigate = useNavigate();
  const { sql: initialSql, item: itemParam } = useSearch({ strict: false }) as {
    sql?: string;
    item?: string;
  };

  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState(
    itemParam ?? (initialSql ? QUERY_ID : OVERVIEW_ID),
  );
  const [sql, setSql] = useState(initialSql ?? SAMPLES[0]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  const loadTables = useCallback(async (force = false) => {
    setTablesLoading(true);
    setTablesError(null);
    try {
      setTables(await api.tables(force ? { force: true } : undefined));
    } catch (e) {
      setTablesError(String(e));
    } finally {
      setTablesLoading(false);
    }
  }, []);

  useEffect(() => { loadTables(); }, [loadTables]);

  const tableItems = useMemo(() => tables.map((t) => tableItem(t.name)), [tables]);
  const tableByName = useMemo(
    () => new Map(tables.map((t) => [t.name, t])),
    [tables],
  );

  const selected = catalogItem(selectedId) ?? OVERVIEW;
  const needle = filter.trim().toLowerCase();
  const toolHits = useMemo(() => TOOLS.filter((i) => itemMatches(i, needle)), [needle]);
  const feedHits = useMemo(() => FEEDS.filter((i) => itemMatches(i, needle)), [needle]);
  const tableHits = useMemo(() => tableItems.filter((i) => itemMatches(i, needle)), [tableItems, needle]);

  const select = (id: string, nextSql?: string) => {
    setSelectedId(id);
    navigate({
      to: '/data',
      search: { item: id, sql: nextSql ?? (id === QUERY_ID ? sql : undefined) },
      replace: true,
    });
  };

  const runQuery = useCallback(async (sqlText: string) => {
    setRunning(true);
    setElapsedMs(null);
    const t0 = performance.now();
    try {
      setResult(await api.query(sqlText));
    } catch (e) {
      setResult({ columns: [], rows: [], row_count: 0, error: String(e) });
    } finally {
      setElapsedMs(Math.round(performance.now() - t0));
      setRunning(false);
    }
  }, []);

  const previewTable = (name: string) => {
    const q = `SELECT * FROM options.${name} LIMIT ${TABLE_PREVIEW_LIMIT};`;
    setSql(q);
    select(`table:${name}`, q);
    runQuery(q);
  };

  const openQuery = (nextSql?: string) => {
    if (nextSql) setSql(nextSql);
    select(QUERY_ID, nextSql ?? sql);
  };

  useEffect(() => {
    if (initialSql) runQuery(initialSql);
    // Seed once from the Chat deep-link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showSql = selected.live === 'sql' || selected.kind === 'query' || selected.kind === 'table';
  const activeTable = selected.kind === 'table' ? selected.title : null;
  const activeInfo = activeTable ? tableByName.get(activeTable) : undefined;
  const activeCols = activeInfo?.columns ?? [];
  const activeSample = activeInfo?.sample ?? [];
  const activeCount = activeInfo?.row_count ?? null;

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runQuery(sql);
    }
  };

  const insertName = (name: string) => setSql((s) => (s ? `${s}\n${name}` : name));

  const related = (ids: string[] | undefined, prefix: 'tool' | 'feed' | 'table') =>
    (ids ?? []).map((raw) => {
      const id = raw.includes(':') ? raw : `${prefix}:${raw}`;
      const item = catalogItem(id);
      return item ? (
        <Button
          key={id}
          size="sm"
          variant="secondary"
          label={item.title}
          onClick={() => (item.kind === 'table' ? previewTable(item.title) : select(item.id))}
        />
      ) : null;
    });

  return (
    <section className="data-page">
      <aside className="data-sidebar" aria-label="Data catalog">
        <VStack gap={3}>
          <HStack gap={2} vAlign="center">
            <Heading level={2}>Catalog</Heading>
            <Button
              size="sm"
              variant="ghost"
              label="Refresh schema"
              isDisabled={tablesLoading}
              onClick={() => loadTables(true)}
            />
          </HStack>
          <Text type="supporting">
            Everything Chat can feed into an answer — tools, APIs, and lake tables.
          </Text>
          <TextInput
            label="Filter catalog"
            isLabelHidden
            placeholder="Filter tools, feeds, tables…"
            value={filter}
            onChange={setFilter}
          />
          {tablesError && <Text className="data-err">{tablesError}</Text>}

          <List density="compact" header="Start here">
            <ListItem
              label={OVERVIEW.title}
              description={OVERVIEW.summary}
              isSelected={selectedId === OVERVIEW_ID}
              onClick={() => select(OVERVIEW_ID)}
            />
            <ListItem
              label={QUERY.title}
              description={QUERY.summary}
              isSelected={selectedId === QUERY_ID}
              onClick={() => openQuery()}
            />
          </List>

          {toolHits.length > 0 && (
            <List density="compact" header="Chat tools">
              {toolHits.map((item) => (
                <ListItem
                  key={item.id}
                  label={item.title}
                  description={item.summary}
                  isSelected={selectedId === item.id}
                  onClick={() => select(item.id)}
                />
              ))}
            </List>
          )}

          {feedHits.length > 0 && (
            <List density="compact" header="Feeds & APIs">
              {feedHits.map((item) => (
                <ListItem
                  key={item.id}
                  label={item.title}
                  description={item.summary}
                  isSelected={selectedId === item.id}
                  onClick={() => select(item.id)}
                />
              ))}
            </List>
          )}

          <List
            density="compact"
            header={tablesLoading ? 'Lake tables (loading…)' : 'Lake tables'}
          >
            {tableHits.map((item) => {
              const count = tableByName.get(item.title)?.row_count;
              return (
                <ListItem
                  key={item.id}
                  label={item.title}
                  description={item.summary}
                  isSelected={selectedId === item.id}
                  endContent={
                    count != null ? (
                      <Text type="supporting">{count.toLocaleString()}</Text>
                    ) : undefined
                  }
                  onClick={() => previewTable(item.title)}
                />
              );
            })}
            {!tablesLoading && tableHits.length === 0 && (
              <ListItem label="No matching tables" isDisabled />
            )}
          </List>
        </VStack>
      </aside>

      <VStack className="data-main" gap={4}>
        <VStack gap={2}>
          <Text type="supporting">{kindLabel(selected.kind)}</Text>
          <Heading level={1}>{selected.kind === 'table' ? `options.${selected.title}` : selected.title}</Heading>
          <Text>{selected.description}</Text>
        </VStack>

        {(selected.provider || selected.cadence || selected.endpoint || selected.kind === 'table') && (
        <MetadataList columns="multi" label={{ position: 'top' }}>
          {selected.provider && (
            <MetadataListItem label="Provider">{selected.provider}</MetadataListItem>
          )}
          {selected.cadence && (
            <MetadataListItem label="Cadence">{selected.cadence}</MetadataListItem>
          )}
          {selected.endpoint && (
            <MetadataListItem label="API">{selected.endpoint}</MetadataListItem>
          )}
          {selected.kind === 'table' && (
            <MetadataListItem label="Rows">
              {activeCount != null ? activeCount.toLocaleString() : '—'}
            </MetadataListItem>
          )}
          {selected.kind === 'table' && activeInfo?.distinct_count != null && (
            <MetadataListItem label={`Distinct ${activeInfo.distinct_key ?? 'keys'}`}>
              {activeInfo.distinct_count.toLocaleString()}
            </MetadataListItem>
          )}
          {selected.kind === 'table' && (
            <MetadataListItem label="Columns">{String(activeCols.length)}</MetadataListItem>
          )}
        </MetadataList>
        )}

        {selected.params && selected.params.length > 0 && (
          <VStack gap={2}>
            <Heading level={2}>Inputs</Heading>
            <List density="compact" hasDividers>
              {selected.params.map((p) => (
                <ListItem
                  key={p.name}
                  label={`${p.name}: ${p.type}`}
                  description={p.note}
                />
              ))}
            </List>
          </VStack>
        )}

        {(selected.feeds?.length || selected.tools?.length || selected.tables?.length) ? (
          <VStack gap={2}>
            <Heading level={2}>Connected</Heading>
            <HStack gap={2} wrap="wrap">
              {related(selected.feeds, 'feed')}
              {related(selected.tools, 'tool')}
              {related(selected.tables, 'table')}
            </HStack>
          </VStack>
        ) : null}

        {selected.kind === 'overview' && (
          <VStack gap={3}>
            <Text type="supporting">
              {TOOLS.length} tools · {FEEDS.length} feeds · {tables.length || '…'} lake tables. Pick anything in the catalog, or query the lake directly.
            </Text>
            <HStack gap={2} wrap="wrap">
              <Button label="Query the lake" onClick={() => openQuery()} />
              <Button variant="secondary" label="FRED calendar" onClick={() => select('feed:fred')} />
              <Button variant="secondary" label="CBOE chains" onClick={() => previewTable('option_contracts')} />
              <Button variant="secondary" label="News tool" onClick={() => select('tool:get_news')} />
            </HStack>
          </VStack>
        )}

        {selected.kind === 'table' && activeCols.length > 0 && (
          <VStack gap={2}>
            <Heading level={2}>Columns</Heading>
            <ul className="data-columns">
              {activeCols.map((c) => (
                <li key={c.name}>
                  <Tooltip content="Append to query" hasHoverIndication={false}>
                    <button type="button" className="data-col-btn" onClick={() => insertName(c.name)}>
                      <span>{c.name}</span>
                      <span>{c.type}</span>
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
            {activeSample.length > 0 && (
              <>
                <Heading level={2}>Sample rows (not the universe)</Heading>
                <ResultGrid
                  columns={activeCols.map((c) => c.name)}
                  rows={activeSample}
                />
              </>
            )}
          </VStack>
        )}

        {selected.live === 'econ' && <LiveEcon />}
        {selected.live === 'news' && <LiveNews />}
        {selected.live === 'search' && <LiveSearch />}

        {showSql && (
          <VStack gap={2} className="data-sql">
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text type="supporting">
                <b>Query editor</b> · Ctrl/Cmd+Enter to run
              </Text>
              <HStack gap={1} className="data-samples">
                {SAMPLES.map((_, i) => (
                  <Button
                    key={i}
                    size="sm"
                    variant="ghost"
                    label={`#${i + 1}`}
                    onClick={() => { setSql(SAMPLES[i]); select(QUERY_ID, SAMPLES[i]); }}
                  />
                ))}
              </HStack>
              <Button
                label={running ? 'Running…' : 'Run query'}
                isDisabled={running}
                onClick={() => runQuery(sql)}
              />
            </HStack>
            <textarea
              className="sql-editor"
              value={sql}
              spellCheck={false}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={onKey}
              placeholder="SELECT * FROM options.option_contracts LIMIT 100"
            />
            <Text type="supporting">
              {result?.error ? (
                <span className="data-err">Error: {result.error}</span>
              ) : result ? (
                <>
                  <b>{result.row_count.toLocaleString()}</b> rows
                  {result.truncated ? ` (truncated at ${result.limit})` : ''}
                  {elapsedMs !== null ? ` · ${elapsedMs} ms` : ''}
                  {' · '}
                  <b>{result.columns.length}</b> columns
                </>
              ) : (
                'Results will appear here.'
              )}
            </Text>
            {result && !result.error && result.columns.length > 0 && (
              <ResultGrid columns={result.columns} rows={result.rows} numbered />
            )}
          </VStack>
        )}
      </VStack>
    </section>
  );
}

function ResultGrid({
  columns,
  rows,
  numbered,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  numbered?: boolean;
}) {
  return (
    <section className="result-wrap">
      <table className="result-table">
        <thead>
          <tr>
            {numbered && <th className="row-idx">#</th>}
            {columns.map((c) => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {numbered && <td className="row-idx">{i + 1}</td>}
              {columns.map((c) => <td key={c}>{fmtCell(row[c])}</td>)}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + (numbered ? 1 : 0)} className="empty">No rows.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function LiveEcon() {
  const [data, setData] = useState<EconCalendarResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.econCalendar(30)
      .then((d) => { setData(d); setError(d.error ?? null); })
      .catch((e) => setError(String(e)));
  }, []);
  return (
    <VStack gap={2}>
      <Heading level={2}>Upcoming 30 days</Heading>
      {error && <Text className="data-err">{error}</Text>}
      {data && (
        <List density="compact" hasDividers header={`${data.items.length} events · ${data.provider}`}>
          {data.items.slice(0, 40).map((ev, i) => (
            <ListItem
              key={`${ev.date}-${ev.title}-${i}`}
              label={ev.title}
              description={`${ev.date}${ev.time ? ` ${ev.time} ET` : ''} · ${ev.kind}`}
            />
          ))}
          {data.items.length === 0 && <ListItem label="No scheduled events in this window" isDisabled />}
        </List>
      )}
    </VStack>
  );
}

function LiveNews() {
  const [symbol, setSymbol] = useState('AAPL');
  const [data, setData] = useState<NewsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.news(symbol, 8);
      setData(d);
      setError(d.error ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <VStack gap={2}>
      <Heading level={2}>Try headlines</Heading>
      <HStack gap={2} vAlign="end">
        <TextInput label="Ticker" value={symbol} onChange={setSymbol} />
        <Button label={loading ? 'Fetching…' : 'Fetch news'} isDisabled={loading || !symbol.trim()} onClick={run} />
      </HStack>
      {error && <Text className="data-err">{error}</Text>}
      {data && (
        <List density="compact" hasDividers header={`${data.items.length} headlines`}>
          {data.items.map((item) => (
            <ListItem key={item.link} label={item.title} description={item.snippet} href={item.link} target="_blank" />
          ))}
          {data.items.length === 0 && <ListItem label="No headlines" isDisabled />}
        </List>
      )}
    </VStack>
  );
}

function LiveSearch() {
  const [query, setQuery] = useState('FOMC next meeting');
  const [data, setData] = useState<WebSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.webSearch(query, 5);
      setData(d);
      setError(d.error ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <VStack gap={2}>
      <Heading level={2}>Try a search</Heading>
      <HStack gap={2} vAlign="end">
        <TextInput label="Query" value={query} onChange={setQuery} />
        <Button label={loading ? 'Searching…' : 'Search'} isDisabled={loading || !query.trim()} onClick={run} />
      </HStack>
      {error && <Text className="data-err">{error}</Text>}
      {data && (
        <List density="compact" hasDividers header={`${data.results.length} results`}>
          {data.results.map((item) => (
            <ListItem key={item.link} label={item.title} description={item.snippet} href={item.link} target="_blank" />
          ))}
          {data.results.length === 0 && <ListItem label="No results" isDisabled />}
        </List>
      )}
    </VStack>
  );
}
