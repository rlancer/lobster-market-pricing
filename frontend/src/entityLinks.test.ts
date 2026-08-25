import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyEntity,
  columnLooksLikeEntity,
  entityResearchPath,
  kalshiSeriesUrl,
  parseKalshiParam,
  parseTickerParam,
} from './entityLinks.ts';
import { etfIssuerMarketingSite } from './externalSites.ts';

describe('classifyEntity', () => {
  it('classifies securities', () => {
    assert.deepEqual(classifyEntity('aapl'), { kind: 'security', id: 'AAPL' });
    assert.deepEqual(classifyEntity('BTC-USD'), { kind: 'security', id: 'BTC-USD' });
    assert.deepEqual(classifyEntity('ES=F'), { kind: 'security', id: 'ES=F' });
  });

  it('classifies Kalshi markets and series', () => {
    assert.deepEqual(classifyEntity('KXFED-27APR-T4.25'), {
      kind: 'kalshi_market',
      id: 'KXFED-27APR-T4.25',
    });
    assert.deepEqual(classifyEntity('kxfed'), { kind: 'kalshi_series', id: 'KXFED' });
  });

  it('builds research paths', () => {
    assert.equal(entityResearchPath({ kind: 'security', id: 'SPY' }), '/research/SPY');
    assert.equal(
      entityResearchPath({ kind: 'kalshi_market', id: 'KXFED-27APR-T4.25' }),
      '/research/kalshi/KXFED-27APR-T4.25',
    );
  });
});

describe('parse helpers', () => {
  it('parseTickerParam accepts lake forms', () => {
    assert.equal(parseTickerParam('^VIX'), '^VIX');
    assert.equal(parseTickerParam('/ES'), 'ES=F');
  });

  it('parseKalshiParam rejects junk and non-KX tickers', () => {
    assert.equal(parseKalshiParam(''), null);
    assert.equal(parseKalshiParam('../x'), null);
    assert.equal(parseKalshiParam('BTC-USD'), null);
  });

  it('kalshiSeriesUrl', () => {
    assert.equal(kalshiSeriesUrl('KXFED'), 'https://kalshi.com/markets/kxfed');
  });

  it('entity columns', () => {
    assert.equal(columnLooksLikeEntity('market_ticker'), true);
    assert.equal(columnLooksLikeEntity('volume'), false);
  });
});

describe('etfIssuerMarketingSite', () => {
  it('maps Vanguard and iShares', () => {
    assert.match(etfIssuerMarketingSite('Vanguard')!.url, /vanguard/);
    assert.match(etfIssuerMarketingSite('iShares')!.url, /ishares/);
  });
});
