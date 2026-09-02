import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finishPortfolioStepsAfterQuerySeed,
  interruptedPortfolioGrounding,
} from '../src/interrupted-portfolio.ts';

test('detects sealed empty assistant after successful get_portfolio', () => {
  // Regression: share 23nE1Q9OqTm1noJSWszE0Qj3E — disconnect after tools, empty content.
  const messages = [
    {
      role: 'user',
      parts: [{ type: 'text', text: 'Any risks you see in my portfolio?' }],
    },
    {
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'Analyzing the book…' },
        {
          type: 'tool-get_portfolio',
          toolName: 'get_portfolio',
          state: 'output-available',
          input: { source: 'schwab' },
          output: { ok: true, summary: 'Schwab portfolio…' },
        },
        {
          type: 'tool-research_ticker',
          toolName: 'research_ticker',
          state: 'output-available',
          input: { symbol: 'SIVR' },
          output: { ok: true, summary: '…' },
        },
      ],
    },
    {
      role: 'user',
      parts: [{ type: 'text', text: 'Finish the portfolio risk review you started…' }],
    },
  ];
  assert.equal(interruptedPortfolioGrounding(messages), true);
});

test('finds get_portfolio on an earlier empty assistant after a failed desk', () => {
  // Regression: share 1Wqv4alqoqTeNBPoj7fjOnfvd — finish #1 stubbed publish_desk;
  // finish #2 must still see the book from the first assistant.
  const messages = [
    {
      role: 'user',
      parts: [{ type: 'text', text: 'Any risks you see in my portfolio?' }],
    },
    {
      role: 'assistant',
      parts: [
        {
          type: 'tool-get_portfolio',
          toolName: 'get_portfolio',
          output: { ok: true, summary: 'Schwab portfolio…' },
        },
        {
          type: 'tool-research_ticker',
          toolName: 'research_ticker',
          output: { ok: true, summary: '…' },
        },
      ],
    },
    {
      role: 'user',
      parts: [{ type: 'text', text: 'Finish the portfolio risk review you started…' }],
    },
    {
      role: 'assistant',
      parts: [
        {
          type: 'tool-publish_desk',
          toolName: 'publish_desk',
          output: { ok: false, error: 'Desk viewpoints incomplete or stubbed.' },
        },
      ],
    },
    {
      role: 'user',
      parts: [{ type: 'text', text: 'Finish the portfolio risk review you started…' }],
    },
  ];
  assert.equal(interruptedPortfolioGrounding(messages), true);
});

test('ignores assistants that already wrote prose', () => {
  const messages = [
    {
      role: 'user',
      parts: [{ type: 'text', text: 'risks?' }],
    },
    {
      role: 'assistant',
      parts: [
        {
          type: 'tool-get_portfolio',
          toolName: 'get_portfolio',
          output: { ok: true, summary: 'ok' },
        },
        { type: 'text', text: 'Concentration risk in silver…' },
      ],
    },
    {
      role: 'user',
      parts: [{ type: 'text', text: 'thanks' }],
    },
  ];
  assert.equal(interruptedPortfolioGrounding(messages), false);
});

test('ignores failed get_portfolio', () => {
  const messages = [
    {
      role: 'user',
      parts: [{ type: 'text', text: 'risks?' }],
    },
    {
      role: 'assistant',
      parts: [
        {
          type: 'tool-get_portfolio',
          toolName: 'get_portfolio',
          output: { ok: false, error: 'not connected' },
        },
      ],
    },
    {
      role: 'user',
      parts: [{ type: 'text', text: 'finish' }],
    },
  ];
  assert.equal(interruptedPortfolioGrounding(messages), false);
});

test('finish seed leaves one auto compose step before forced desk', () => {
  // Regression: seeding == AUTO forced publish_desk on step 0 → stub rejection.
  assert.equal(finishPortfolioStepsAfterQuerySeed(2), 1);
  assert.equal(finishPortfolioStepsAfterQuerySeed(5), 4);
  assert.equal(finishPortfolioStepsAfterQuerySeed(0), 0);
});
