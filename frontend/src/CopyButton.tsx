import { useState } from 'react';
import { Tooltip } from '@astryxdesign/core';

/**
 * Small inline copy-to-clipboard button with transient "Copied ✓" feedback.
 * Shared by the chat (SQL blocks, share URL dialog) and the public share page
 * — one implementation, styled by its context (`.ai-sql-head button`,
 * `.ai-share-row`).
 */
export function CopyButton({ text, tooltip = 'Copy' }: { text: string; tooltip?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };
  return (
    <Tooltip content={tooltip} hasHoverIndication={false}>
      <button type="button" className="ai-sql-copy" onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </Tooltip>
  );
}