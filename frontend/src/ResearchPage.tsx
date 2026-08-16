import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Button,
  Heading,
  HStack,
  Text,
  TextInput,
  VStack,
} from '@astryxdesign/core';
import { api, type ChatTickerLink, type TickerResearch } from './api';
import { ResearchBriefView, ResearchLoading } from './ResearchBrief';
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setDraft(tickerParam);
  }, [tickerParam]);

  // Price + brief first — paint spot as soon as research returns.
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
      api.researchChats(tickerParam).catch(() => ({ ticker: tickerParam, security_id: '', items: [] as ChatTickerLink[] })),
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

  // Lobster commentary loads in parallel / after so the price hero is not blocked.
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

  return (
    <VStack className="research-page" gap={5}>
      {!tickerParam && (
        <VStack gap={2} className="research-page-head">
          <Heading level={1}>Ticker details</Heading>
          <Text type="supporting">
            Spot, Lobster commentary, and the research brief for one underlying.
            Linked from tickers Copilot extracts in chat.
          </Text>
          <HStack gap={2} vAlign="end" className="research-lookup">
            <TextInput
              label="Ticker"
              value={draft}
              onChange={(value) => setDraft(String(value).toUpperCase())}
              placeholder="NVDA"
            />
            <Button label="Open" onClick={() => go(draft)} />
          </HStack>
        </VStack>
      )}

      {tickerParam && (
        <HStack gap={2} vAlign="end" className="research-lookup research-lookup-inline">
          <TextInput
            label="Ticker"
            value={draft}
            onChange={(value) => setDraft(String(value).toUpperCase())}
            placeholder="NVDA"
          />
          <Button label="Open" onClick={() => go(draft)} />
        </HStack>
      )}

      {!tickerParam && (
        <VStack gap={2} className="research-empty">
          <Text>Enter a ticker, or open one from a chat ticker chip.</Text>
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
        />
      )}
    </VStack>
  );
}
