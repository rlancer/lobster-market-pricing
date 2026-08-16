import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import {
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
import './Research.css';

export default function ResearchPage() {
  const params = useParams({ strict: false }) as { ticker?: string };
  const tickerParam = params.ticker?.trim().toUpperCase() ?? '';
  const [research, setResearch] = useState<TickerResearch | null>(null);
  const [commentary, setCommentary] = useState<string | null>(null);
  const [commentaryLoading, setCommentaryLoading] = useState(false);
  const [related, setRelated] = useState<ChatTickerLink[]>([]);
  const [ohlc, setOhlc] = useState<OhlcBar[]>([]);
  const [ohlcLoading, setOhlcLoading] = useState(false);
  const [contracts, setContracts] = useState<ChainContract[]>([]);
  const [expirations, setExpirations] = useState<string[]>([]);
  const [chainLoading, setChainLoading] = useState(false);
  const [chainActive, setChainActive] = useState(false);
  const [chainExpiration, setChainExpiration] = useState<string | undefined>(undefined);
  const [chainNearSpot, setChainNearSpot] = useState(50);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Reset staged payloads when the ticker changes.
  useEffect(() => {
    setCommentary(null);
    setCommentaryLoading(false);
    setOhlc([]);
    setOhlcLoading(false);
    setContracts([]);
    setExpirations([]);
    setChainLoading(false);
    setChainActive(false);
    setChainExpiration(undefined);
    setChainNearSpot(50);
  }, [tickerParam]);

  // 1) Research brief first — price hero paints without waiting on OHLC/chain.
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
        // Seed Lobster bubble from the brief when commentary already rode along.
        if (brief.commentary?.trim()) {
          setCommentary(brief.commentary.trim());
        }
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

  // 2) After the brief is up: commentary + OHLC in parallel (no full chain yet).
  useEffect(() => {
    if (!tickerParam || !research) return;
    let active = true;

    setCommentaryLoading(true);
    api.researchCommentary(tickerParam)
      .then((res) => {
        if (active) setCommentary(res.commentary);
      })
      .catch(() => {
        // Keep any brief-seeded commentary; only clear if we had nothing.
        if (active && !research.commentary?.trim()) setCommentary(null);
      })
      .finally(() => {
        if (active) setCommentaryLoading(false);
      });

    setOhlcLoading(true);
    api.symbolDetail(tickerParam, { parts: 'ohlc' })
      .then((detail) => {
        if (!active) return;
        setOhlc(detail.ohlc ?? []);
      })
      .catch(() => {
        if (active) setOhlc([]);
      })
      .finally(() => {
        if (active) setOhlcLoading(false);
      });

    return () => { active = false; };
  }, [tickerParam, research]);

  // 3) Options chain — only after the section scrolls near the viewport, and
  //    only one expiration + near-spot window (not the legacy 1MB dump).
  useEffect(() => {
    if (!tickerParam || !chainActive) return;
    let active = true;
    setChainLoading(true);
    api.symbolDetail(tickerParam, {
      parts: 'chain',
      expiration: chainExpiration,
      near_spot: chainNearSpot > 0 ? chainNearSpot : undefined,
    })
      .then((detail) => {
        if (!active) return;
        setExpirations(detail.expirations ?? []);
        setContracts(detail.contracts ?? []);
      })
      .catch(() => {
        if (!active) return;
        setContracts([]);
        setExpirations([]);
      })
      .finally(() => {
        if (active) setChainLoading(false);
      });
    return () => { active = false; };
  }, [tickerParam, chainActive, chainExpiration, chainNearSpot]);

  return (
    <VStack className="research-page" gap={3}>
      {!tickerParam && (
        <VStack gap={2} className="research-page-head">
          <Heading level={1}>Ticker details</Heading>
          <Text type="supporting">
            Spot, chart, Lobster take, and the options chain for one underlying.
            Search any ticker from the header — or jump to a common name below.
          </Text>
        </VStack>
      )}

      {!tickerParam && (
        <VStack gap={2} className="research-empty">
          <Text type="supporting">Common underlyings:</Text>
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
          ohlcLoading={ohlcLoading}
          contracts={contracts}
          expirations={expirations}
          chainLoading={chainLoading}
          onChainVisible={() => setChainActive(true)}
          chainExpiration={chainExpiration}
          chainNearSpot={chainNearSpot}
          onChainExpirationChange={setChainExpiration}
          onChainNearSpotChange={setChainNearSpot}
        />
      )}
    </VStack>
  );
}
