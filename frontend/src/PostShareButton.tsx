import { useEffect, useState } from 'react';
import { DropdownMenu } from '@astryxdesign/core';
import { Link2, Share2, Upload } from 'lucide-react';

/** Resolve a relative Worker path (e.g. `/share/abc`) to an absolute URL. */
function absoluteUrl(pathOrUrl: string): string {
  return new URL(pathOrUrl, window.location.href).toString();
}

/** Fragment id for a turn inside a shared transcript (`#m-0`, `#m-1`, …). */
export function messageShareFragment(index: number): string {
  return `m-${Math.max(0, Math.floor(index))}`;
}

/** Capability URL that deep-links to one turn in `/share/:id` (or a timeline post url). */
export function messageShareUrl(sharePathOrUrl: string, index: number): string {
  const base = sharePathOrUrl.split('#')[0] || sharePathOrUrl;
  return `${base}#${messageShareFragment(index)}`;
}

/**
 * Share control for a public post — icon trigger with Copy link and
 * Share via… (system share sheet when available). Used on the timeline
 * feed, the /share page, and per-turn rows inside a conversation.
 */
export function PostShareButton({
  url,
  title,
  tooltip = 'Share',
  label = 'Share post',
}: {
  /** Relative or absolute post URL, e.g. `/share/abc` or `/share/abc#m-2`. */
  url: string;
  title: string;
  tooltip?: string;
  label?: string;
}) {
  // Detect after mount so SSR/hydration never disagree on the menu shape.
  const [canNativeShare, setCanNativeShare] = useState(false);
  useEffect(() => {
    setCanNativeShare(typeof navigator.share === 'function');
  }, []);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(absoluteUrl(url));
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  const shareVia = async () => {
    if (typeof navigator.share !== 'function') return;
    try {
      await navigator.share({
        title: title.trim() || 'Shared chat',
        url: absoluteUrl(url),
      });
    } catch {
      /* user cancelled the sheet — ignore */
    }
  };

  return (
    <DropdownMenu
      className="post-share"
      hasChevron={false}
      menuWidth="11rem"
      button={{
        label,
        icon: <Share2 size={16} aria-hidden="true" />,
        variant: 'ghost',
        size: 'sm',
        isIconOnly: true,
        tooltip,
      }}
      items={[
        {
          label: 'Copy link',
          icon: <Link2 size={16} aria-hidden="true" />,
          onClick: () => {
            void copyLink();
          },
        },
        ...(canNativeShare
          ? [{
              label: 'Share via…',
              icon: <Upload size={16} aria-hidden="true" />,
              onClick: () => {
                void shareVia();
              },
            }]
          : []),
      ]}
    />
  );
}
