/**
 * Clickable entity — primary destination is in-app research
 * (/research/{ticker} or /research/kalshi/{marketTicker}). Optional external
 * Kalshi / company / issuer links render as secondary actions when provided.
 */

import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  classifyEntity,
  kalshiSeriesUrl,
  type ClassifiedEntity,
} from './entityLinks';
import './EntityLink.css';

export interface EntityExternalLink {
  label: string;
  href: string;
}

export function EntityLink({
  value,
  children,
  className,
  external,
  showExternals = false,
}: {
  value: string | null | undefined;
  children?: ReactNode;
  className?: string;
  /** Extra external destinations (company site, issuer, Kalshi trade, …). */
  external?: EntityExternalLink[];
  /** When true, render secondary external anchors after the primary link. */
  showExternals?: boolean;
}) {
  const entity = classifyEntity(value);
  const label = children ?? value ?? '—';
  if (!entity) {
    return <span className={className}>{label}</span>;
  }

  const primary = <PrimaryResearchLink entity={entity} className={className}>{label}</PrimaryResearchLink>;

  const externals = showExternals
    ? [
        ...(external ?? []),
        ...defaultExternals(entity),
      ]
    : (external ?? []);

  if (!showExternals || externals.length === 0) {
    return primary;
  }

  return (
    <span className="entity-link-group">
      {primary}
      {externals.map((link) => (
        <a
          key={link.href}
          href={link.href}
          className="entity-link-external"
          target="_blank"
          rel="noreferrer"
        >
          {link.label}
        </a>
      ))}
    </span>
  );
}

function PrimaryResearchLink({
  entity,
  className,
  children,
}: {
  entity: ClassifiedEntity;
  className?: string;
  children: ReactNode;
}) {
  if (entity.kind === 'security') {
    return (
      <Link
        to="/research/$ticker"
        params={{ ticker: entity.id }}
        className={className ?? 'entity-link'}
      >
        {children}
      </Link>
    );
  }
  return (
    <Link
      to="/research/kalshi/$marketTicker"
      params={{ marketTicker: entity.id }}
      className={className ?? 'entity-link'}
    >
      {children}
    </Link>
  );
}

function defaultExternals(entity: ClassifiedEntity): EntityExternalLink[] {
  if (entity.kind === 'security') return [];
  const series = entity.kind === 'kalshi_series'
    ? entity.id
    : entity.id.split('-')[0] ?? entity.id;
  const url = kalshiSeriesUrl(series);
  if (!url) return [];
  return [{ label: 'Kalshi', href: url }];
}

/** Convenience: link a trade leg's market_ticker or symbol. */
export function LegEntityLink({
  marketTicker,
  symbol,
  className,
}: {
  marketTicker?: string | null;
  symbol?: string | null;
  className?: string;
}) {
  if (marketTicker) {
    return <EntityLink value={marketTicker} className={className} showExternals />;
  }
  if (symbol) {
    return <EntityLink value={symbol} className={className} />;
  }
  return null;
}
