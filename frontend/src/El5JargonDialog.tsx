import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogHeader,
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  List,
  ListItem,
  Markdown,
  Spinner,
  Text,
  VStack,
} from '@astryxdesign/core';
import { Lightbulb } from 'lucide-react';
import { api, type El5Translation } from './api';
import './El5JargonDialog.css';

type JargonTerm = {
  term: string;
  el5: string;
};

type JargonGroup = {
  title: string;
  terms: JargonTerm[];
};

/** Terms that show up across Research, options chain, Copilot, and Kalshi. */
const JARGON_GROUPS: JargonGroup[] = [
  {
    title: 'Price basics',
    terms: [
      {
        term: 'Spot',
        el5: 'The sticker price of the stock or coin right now — what you’d pay if you bought one share this second.',
      },
      {
        term: 'Bid / Ask',
        el5: 'Bid is what buyers will pay. Ask is what sellers want. The gap between them is the “spread” — like two kids arguing over the price of a candy bar.',
      },
      {
        term: 'Volume',
        el5: 'How many shares (or contracts) changed hands today. Lots of volume means lots of people are playing; quiet volume means the playground is empty.',
      },
      {
        term: 'PnL',
        el5: 'Profit and Loss — how much you made or lost. Green means “yay, more ice cream”; red means “oops.”',
      },
    ],
  },
  {
    title: 'Options (the chain)',
    terms: [
      {
        term: 'Call',
        el5: 'A ticket that pays off if the price goes up. You’re cheering for the rocket.',
      },
      {
        term: 'Put',
        el5: 'A ticket that pays off if the price goes down. You’re cheering for the parachute.',
      },
      {
        term: 'Strike',
        el5: 'The magic number on the ticket. For a call, you want the stock above this number; for a put, below it.',
      },
      {
        term: 'Premium',
        el5: 'What you pay for the ticket. Buy it cheap, hope it becomes worth more — like a fairground ride pass that gets hotter.',
      },
      {
        term: 'DTE',
        el5: 'Days To Expiration — how many sleeps until the ticket expires and turns into a pumpkin.',
      },
      {
        term: 'ATM / ITM / OTM',
        el5: 'At / In / Out of the Money. ATM = strike hugs the spot price. ITM = already a winner if you used it now. OTM = still needs the price to move your way.',
      },
      {
        term: 'IV (Implied Vol)',
        el5: 'How jumpy the market thinks the price will be. High IV = everyone expects big swings (stormy weather). Low IV = calm seas.',
      },
      {
        term: 'Delta (Δ)',
        el5: 'Roughly how much the option’s price wiggles when the stock moves $1. Near 1 = moves almost like the stock; near 0 = barely budges.',
      },
      {
        term: 'OI (Open Interest)',
        el5: 'How many tickets are still out there, not closed yet. High OI = a crowded ride; low OI = you’re almost alone.',
      },
    ],
  },
  {
    title: 'Company stats',
    terms: [
      {
        term: 'Mkt cap',
        el5: 'Market cap — the whole company’s price tag (share price × how many shares exist). Big number = giant company.',
      },
      {
        term: 'P/E',
        el5: 'Price divided by Earnings. How many dollars you pay for each dollar the company earned. High can mean “expensive hope”; low can mean “bargain or broken.”',
      },
      {
        term: 'Short interest',
        el5: 'How many people bet the stock will fall. Lots of shorts = a big crowd rooting against it.',
      },
      {
        term: 'RV30',
        el5: 'Realized volatility over ~30 days — how jumpy the stock actually was recently, not just what people guessed (that’s IV).',
      },
    ],
  },
  {
    title: 'Event markets (Kalshi)',
    terms: [
      {
        term: 'YES / NO',
        el5: 'A bet on whether something happens (election, Fed cut, weather…). YES odds near 80¢ means the crowd thinks it’s pretty likely — like an 80% chance.',
      },
    ],
  },
];

function JargonBody() {
  return (
    <VStack gap={5}>
      <Text type="supporting">
        Plain-English cheat sheet for the words you’ll see on Research, the options
        chain, and Copilot. Read a term, then spot it in the UI.
      </Text>
      {JARGON_GROUPS.map((group) => (
        <List
          key={group.title}
          density="compact"
          hasDividers
          header={group.title}
        >
          {group.terms.map((entry) => (
            <ListItem
              key={entry.term}
              label={entry.term}
              description={(
                <Text type="supporting">{entry.el5}</Text>
              )}
            />
          ))}
        </List>
      ))}
    </VStack>
  );
}

/**
 * EL5 (“explain like I’m 5”) trading-jargon glossary.
 * Button + modal — drop the button anywhere dense jargon appears.
 */
export function El5JargonButton({
  size = 'sm',
  variant = 'ghost',
}: {
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary';
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        label="EL5"
        variant={variant}
        size={size}
        tooltip="Explain trading jargon like I’m 5"
        icon={<Lightbulb size={14} />}
        onClick={() => setOpen(true)}
      />
      <Dialog
        isOpen={open}
        onOpenChange={setOpen}
        purpose="info"
        width={520}
        maxHeight="85vh"
      >
        {/* Dialog is height:fit-content — shell + scroll class give a real scrollport. */}
        <Layout
          className="el5-dialog-shell"
          header={
            <DialogHeader
              title="Trading jargon · EL5"
              subtitle="Kid-simple meanings for the words on this desk."
              onOpenChange={setOpen}
            />
          }
          content={
            <LayoutContent isScrollable className="el5-dialog-scroll">
              <JargonBody />
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button
                  label="Got it"
                  variant="primary"
                  onClick={() => setOpen(false)}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </>
  );
}

/** Module cache so reopening a post does not refetch a translation we already have. */
const EL5_CLIENT_CACHE_VERSION = 2;
const el5ClientCache = new Map<string, El5Translation>();

function el5ClientCacheKey(shareId: string): string {
  return `v${EL5_CLIENT_CACHE_VERSION}:${shareId}`;
}

/**
 * Per-post EL5: opens a modal and loads (or generates) a cached kid-simple
 * rewrite of that public share.
 */
export function El5PostButton({
  shareId,
  title,
}: {
  shareId: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [translation, setTranslation] = useState<El5Translation | null>(
    () => el5ClientCache.get(el5ClientCacheKey(shareId)) ?? null,
  );

  useEffect(() => {
    if (!open) return;
    const cacheKey = el5ClientCacheKey(shareId);
    const cached = el5ClientCache.get(cacheKey);
    if (cached) {
      setTranslation(cached);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Server hash includes EL5_CACHE_VERSION — stale D1 rows miss and regenerate.
    api.shareEl5(shareId)
      .then((result) => {
        if (cancelled) return;
        el5ClientCache.set(cacheKey, result);
        setTranslation(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, shareId]);

  return (
    <>
      <Button
        className="el5-post"
        label="EL5"
        variant="ghost"
        size="sm"
        tooltip="Explain this post like I’m 5"
        icon={<Lightbulb size={14} />}
        onClick={() => setOpen(true)}
      />
      <Dialog
        isOpen={open}
        onOpenChange={setOpen}
        purpose="info"
        width={520}
        maxHeight="85vh"
      >
        {/* Dialog is height:fit-content — shell + scroll class give a real scrollport. */}
        <Layout
          className="el5-dialog-shell"
          header={
            <DialogHeader
              title="EL5"
              subtitle={title?.trim() || "Kid-simple version of this post."}
              onOpenChange={setOpen}
            />
          }
          content={
            <LayoutContent isScrollable className="el5-dialog-scroll">
              {loading ? (
                <HStack gap={2} vAlign="center">
                  <Spinner size="sm" />
                  <Text type="supporting">Translating the jargon…</Text>
                </HStack>
              ) : error ? (
                <Text type="supporting">{error}</Text>
              ) : translation ? (
                <VStack gap={2} className="el5-post-body ai-text">
                  <Markdown>{translation.el5}</Markdown>
                </VStack>
              ) : null}
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button
                  label="Got it"
                  variant="primary"
                  onClick={() => setOpen(false)}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </>
  );
}
