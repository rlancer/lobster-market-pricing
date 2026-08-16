import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Button,
  Heading,
  HStack,
  Text,
  VStack,
} from '@astryxdesign/core';
import {
  api,
  type ChatTickerLink,
  type ChainContract,
  type OhlcBar,
  type TickerResearch,
} from './api';
import { ResearchBriefView, ResearchLoading } from './ResearchBrief';
import { TickerTypeahead } from './TickerTypeahead';
import './Research.css';

export default function ResearchPage() {
  const params = useParams({ strict: false }) as { ticker?: string };
  const navigate = useNavigate();
  const tickerParam = params.ticker?.trim().toUpperCase() ?? '';
  const [draft, setDraft] = useState(tickerParam);
  const [research, setResearch] = useState<TickerResearch | null>(null);
  const [commentary, setCommentary] = useState<string | null>(null);
  const [commentaryLoading, setCommentaryLoading] = useState(false);
  const [related, setRelated] = useState<ChatTickerLink[]>([]);
  const [ohlc, setOhlc] = useState<OhlcBar[]>([]);
  const [contracts, setContracts] = useState<ChainContract[]>([]);
  const [expirations, setExpirations] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setDraft(tickerParam);
  }, [tickerParam]);

  // Research brief + related chats first (price paints immediately).
  useEffect(() => {
    if (!tickerParam) {
      setResearch(null);
      setRelated([]);
      setError(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    setResearch(null);
    Promise.all([
      api.research(tickerParam),
      api.researchChats(tickerParam).catch(() => ({
        ticker: tickerParam,
        security_id: '',
        items: [] as ChatTickerLink[],
      })),
    ])
      .then(([brief, chats]) => {
        if (!active) return;
        setResearch(brief);
        setRelated(chats.items);
      })
      .catch((e) => {
        if (!active) return;
        setResearch(null);
        setRelated([]);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [tickerParam]);

  // Symbol detail (OHLC + chain) loads in parallel — does not block the price hero.
  useEffect(() => {
    if (!tickerParam) {
      setOhlc([]);
      setContracts([]);
      setExpirations([]);
      return;
    }
    let active = true;
    setOhlc([]);
    setContracts([]);
    setExpirations([]);
    api.symbolDetail(tickerParam)
      .then((detail) => {
        if (!active) return;
        setOhlc(detail.ohlc ?? []);
        setContracts(detail.contracts ?? []);
        setExpirations(detail.expirations ?? []);
      })
      .catch(() => {
        if (!active) return;
        setOhlc([]);
        setContracts([]);
        setExpirations([]);
      });
    return () => { active = false; };
  }, [tickerParam]);

  useEffect(() => {
    if (!tickerParam) {
      setCommentary(null);
      setCommentaryLoading(false);
      return;
    }
    let active = true;
    setCommentary(null);
    setCommentaryLoading(true);
    api.researchCommentary(tickerParam)
      .then((res) => {
        if (active) setCommentary(res.commentary);
      })
      .catch(() => {
        if (active) setCommentary(null);
      })
      .finally(() => {
        if (active) setCommentaryLoading(false);
      });
    return () => { active = false; };
  }, [tickerParam]);

  const go = (symbol: string) => {
    const next = symbol.trim().toUpperCase();
    if (!next) return;
    void navigate({ to: '/research/$ticker', params: { ticker: next } });
  };

  const clear = () => {
    setDraft('');
    void navigate({ to: '/research' });
  };

  return (
    <VStack className="research-page" gap={3}>
      {!tickerParam && (
        <VStack gap={2} className="research-page-head">
          <Heading level={1}>Ticker details</Heading>
          <Text type="supporting">
            Spot, chart, Lobster take, and the options chain for one underlying.
            Linked from tickers Copilot extracts in chat.
          </Text>
        </VStack>
      )}

      <HStack gap={2} vAlign="end" className="research-lookup">
        <TickerTypeahead
          value={tickerParam || null}
          onSelect={go}
          onClear={clear}
          onChangeQuery={(q) => setDraft(q.trim().toUpperCase())}
        />
        <Button label="Open" onClick={() => go(draft || tickerParam)} />
      </HStack>

      {!tickerParam && (
        <VStack gap={2} className="research-empty">
          <Text type="supporting">Or jump to a common underlying:</Text>
          <HStack gap={2}>
            {['AAPL', 'NVDA', 'SPY', 'TSLA'].map((sym) => (
              <Link key={sym} to="/research/$ticker" params={{ ticker: sym }} className="research-chip-link">
                {sym}
              </Link>
            ))}
          </HStack>
        </VStack>
      )}

      {tickerParam && loading && !research && <ResearchLoading label={`Loading ${tickerParam}…`} />}
      {tickerParam && error && <Text className="research-err">{error}</Text>}
      {tickerParam && research && (
        <ResearchBriefView
          research={research}
          relatedChats={related}
          commentary={commentary}
          commentaryLoading={commentaryLoading}
          ohlc={ohlc}
          contracts={contracts}
          expirations={expirations}
        />
      )}
    </VStack>
  );
}
