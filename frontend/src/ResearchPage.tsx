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
  type ResearchChatLink,
  type ChainContract,
  type OhlcBar,
  type TickerEarningsIntel,
  type TickerResearch,
} from './api';
import { ResearchBriefView, ResearchLoading } from './ResearchBrief';
import { AsOfDateField } from './AsOfDateField';
import { El5JargonButton } from './El5JargonDialog';
import { usePageMeta } from './usePageMeta';
import { whenIdle, isResearchBriefReady, pendingTickerResearch } from './researchLazy';
import { useAsOfDate } from './useAsOfDate';
import './Research.css';

export default function ResearchPage() {
  const { asOf } = useAsOfDate();
  const params = useParams({ strict: false }) as { ticker?: string };
  const tickerParam = params.ticker?.trim().toUpperCase() ?? '';
  const [research, setResearch] = useState<TickerResearch | null>(
    () => tickerParam ? pendingTickerResearch(tickerParam) : null,
  );
  const [commentary, setCommentary] = useState<string | null>(null);
  const [commentaryLoading, setCommentaryLoading] = useState(false);
  const [commentaryActive, setCommentaryActive] = useState(false);
  const [earningsIntel, setEarningsIntel] = useState<TickerEarningsIntel | null>(null);
  const [earningsLoading, setEarningsLoading] = useState(false);
  const [related, setRelated] = useState<ResearchChatLink[]>([]);
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
  const briefReady = isResearchBriefReady(research);
  const researchName = research?.identity.name?.trim() || '';
  usePageMeta(
    tickerParam && researchName
      ? {
          description: `${researchName} (${tickerParam}) — spot, options chain, implied vol, greeks, and news.`,
        }
      : null,
  );

  // Reset staged payloads when the ticker changes. Paint the ticker shell
  // immediately so first paint does not wait on GET /api/research.
  useEffect(() => {
    setCommentary(null);
    setCommentaryLoading(false);
    setCommentaryActive(false);
    setEarningsIntel(null);
    setEarningsLoading(false);
    setRelated([]);
    setOhlc([]);
    setOhlcLoading(false);
    setContracts([]);
    setExpirations([]);
    setChainLoading(false);
    setChainActive(false);
    setChainExpiration(undefined);
    setChainNearSpot(50);
    setResearch(tickerParam ? pendingTickerResearch(tickerParam) : null);
    setError(null);
  }, [tickerParam]);

  // 1) Research brief only — never wait on chats / chart / chain / commentary.
  useEffect(() => {
    if (!tickerParam) {
      setResearch(null);
      setError(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    api.research(tickerParam)
      .then((brief) => {
        if (!active) return;
        setResearch(brief);
        if (brief.commentary?.trim()) {
          setCommentary(brief.commentary.trim());
        }
      })
      .catch((e) => {
        if (!active) return;
        setResearch(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [tickerParam]);

  // Related chats — idle after the brief paints (footer chrome, not critical path).
  useEffect(() => {
    if (!tickerParam || !briefReady) return;
    let active = true;
    const cancel = whenIdle(() => {
      api.researchChats(tickerParam)
        .then((chats) => {
          if (active) setRelated(chats.items);
        })
        .catch(() => {
          if (active) setRelated([]);
        });
    });
    return () => {
      active = false;
      cancel();
    };
  }, [tickerParam, briefReady]);

  // Headlines — Tavily stays off the brief API; fill in on idle from /api/news.
  useEffect(() => {
    if (!tickerParam || !briefReady) return;
    let active = true;
    const cancel = whenIdle(() => {
      api.news(tickerParam, 12)
        .then((res) => {
          if (!active || !res.items.length) return;
          setResearch((prev) => {
            if (!prev || prev.identity.ticker !== tickerParam) return prev;
            return {
              ...prev,
              news: res.items.map((item) => ({ title: item.title, link: item.link })),
            };
          });
        })
        .catch(() => { /* news is optional chrome */ });
    });
    return () => {
      active = false;
      cancel();
    };
  }, [tickerParam, briefReady]);

  // SEC filings / ETF prospectuses — lake read, idle after brief paints.
  useEffect(() => {
    if (!tickerParam || !briefReady) return;
    let active = true;
    const cancel = whenIdle(() => {
      api.researchFilings(tickerParam, 16)
        .then((res) => {
          if (!active || !res.items.length) return;
          setResearch((prev) => {
            if (!prev || prev.identity.ticker !== tickerParam) return prev;
            return { ...prev, filings: res.items };
          });
        })
        .catch(() => { /* filings are optional chrome */ });
    });
    return () => {
      active = false;
      cancel();
    };
  }, [tickerParam, briefReady]);

  // Related Kalshi event markets — same idle chrome path as filings.
  useEffect(() => {
    if (!tickerParam || !briefReady) return;
    let active = true;
    const cancel = whenIdle(() => {
      api.researchKalshi(tickerParam, 12)
        .then((res) => {
          if (!active || !res.items.length) return;
          setResearch((prev) => {
            if (!prev || prev.identity.ticker !== tickerParam) return prev;
            return { ...prev, kalshi: res.items };
          });
        })
        .catch(() => { /* kalshi is optional chrome */ });
    });
    return () => {
      active = false;
      cancel();
    };
  }, [tickerParam, briefReady]);

  // Earnings intel (results + SEC facts + AI summary) — equities only, idle.
  useEffect(() => {
    if (!tickerParam || !briefReady || !research || research.etf) return;
    let active = true;
    setEarningsLoading(true);
    const cancel = whenIdle(() => {
      api.researchEarnings(tickerParam)
        .then((intel) => {
          if (active) setEarningsIntel(intel);
        })
        .catch(() => {
          if (active) setEarningsIntel(null);
        })
        .finally(() => {
          if (active) setEarningsLoading(false);
        });
    });
    return () => {
      active = false;
      cancel();
    };
  }, [tickerParam, briefReady, research?.etf, research?.computed_at]);

  // 2) OHLC — start with the brief (chart sits above the fold; parts=ohlc is
  //    a single date-bounded lake query, not the full enrichment suite).
  useEffect(() => {
    if (!tickerParam || !briefReady) return;
    let active = true;
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
  }, [tickerParam, briefReady]);

  // 3) Commentary — only when The Lobster's Take is near the viewport, and only if the
  //    brief did not already carry a take (avoids a duplicate Worker hit).
  useEffect(() => {
    if (!tickerParam || !briefReady || !commentaryActive || !research) return;
    if (research.commentary?.trim()) {
      setCommentary(research.commentary.trim());
      setCommentaryLoading(false);
      return;
    }
    let active = true;
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
  }, [tickerParam, research, briefReady, commentaryActive]);

  // 4) Options chain — explicit user action only (click-to-load), one expiry.
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
    <VStack className="research-page content-column" gap={3}>
      {!tickerParam && (
        <VStack gap={2} className="research-page-head">
          <HStack gap={3} vAlign="center">
            <Heading level={1}>Ticker details</Heading>
            <El5JargonButton />
          </HStack>
          <Text type="supporting">
            Spot, chart, the Lobster's take, and the options chain for one underlying.
            Search any ticker from the header — or jump to a common name below.
          </Text>
          <AsOfDateField
            description="Optional. Replay lake bars as of this ET date when you open a ticker."
          />
        </VStack>
      )}

      {!tickerParam && (
        <VStack gap={2} className="research-empty">
          <Text type="supporting">Common underlyings:</Text>
          <HStack gap={2}>
            {['AAPL', 'NVDA', 'SPY', 'IBIT', 'BTC-USD'].map((sym) => (
              <Link
                key={sym}
                to="/research/$ticker"
                params={{ ticker: sym }}
                search={asOf ? { asof: asOf } : undefined}
                className="research-chip-link"
              >
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
          earningsIntel={earningsIntel}
          earningsLoading={earningsLoading}
          ohlc={ohlc}
          ohlcLoading={ohlcLoading}
          contracts={contracts}
          expirations={expirations}
          chainLoading={chainLoading}
          chainArmed={chainActive}
          onCommentaryVisible={() => setCommentaryActive(true)}
          onChainRequest={() => setChainActive(true)}
          chainExpiration={chainExpiration}
          chainNearSpot={chainNearSpot}
          onChainExpirationChange={setChainExpiration}
          onChainNearSpotChange={setChainNearSpot}
        />
      )}
    </VStack>
  );
}
