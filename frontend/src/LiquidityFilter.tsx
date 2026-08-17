import { useEffect, useState } from 'react';
import { Popover, Text, VStack } from '@astryxdesign/core';
import { api, type LiquidityInfo } from './api';
import './LiquidityFilter.css';

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
}

/** Global "liquid only" toggle, with an info popover that explains the
 * tradability criteria (fetched from /api/liquidity on first open). */
export default function LiquidityFilter({ checked, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<LiquidityInfo | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || info || loading) return;
    setLoading(true);
    api.liquidity()
      .then((d) => setInfo(d))
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
  }, [open, info, loading]);

  const d = info?.enabled_defaults;

  return (
    <section className="liq-filter">
      <label className="liq-toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="liq-label">Tradable names only</span>
      </label>
      <Popover
        placement="above"
        alignment="start"
        label="Liquidity criteria"
        width="20rem"
        isOpen={open}
        onOpenChange={setOpen}
        content={(
          <VStack gap={3} className="liq-popover-copy">
            <Text type="label" weight="semibold">Tradability rules</Text>
            {loading && !info ? (
              <Text type="supporting">Loading…</Text>
            ) : null}
            {info ? (
              <VStack gap={2}>
                <Text type="supporting">{info.description}</Text>
                <Text type="supporting">
                  <b>{info.liquid_underlyings.toLocaleString()}</b>
                  {' of '}
                  <b>{info.total_underlyings.toLocaleString()}</b>
                  {' underlyings currently qualify.'}
                </Text>
              </VStack>
            ) : null}
            {d ? (
              <dl className="liq-criteria">
                <div><dt>Min near-ATM contracts</dt><dd>≥ {d.min_atm_contracts}</dd></div>
                <div><dt>ATM band</dt><dd>± {Math.round(d.atm_band * 100)}% of spot</dd></div>
                <div><dt>Max bid/ask spread</dt><dd>≤ {Math.round(d.max_spread * 100)}% relative</dd></div>
                <div><dt>Min volume</dt><dd>≥ {d.min_volume}</dd></div>
                <div><dt>Min open interest</dt><dd>≥ {d.min_open_interest}</dd></div>
              </dl>
            ) : null}
          </VStack>
        )}
      >
        <button
          type="button"
          className="liq-info-btn"
          aria-label="How is tradability determined?"
          aria-expanded={open}
        >
          i
        </button>
      </Popover>
    </section>
  );
}
