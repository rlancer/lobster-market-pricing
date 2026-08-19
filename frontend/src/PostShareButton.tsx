import { DropdownMenu } from '@astryxdesign/core';
import { Link2, Share2, X } from 'lucide-react';

/** Resolve a relative Worker path (e.g. `/share/abc`) to an absolute URL. */
function absoluteUrl(pathOrUrl: string): string {
  return new URL(pathOrUrl, window.location.href).toString();
}

/**
 * Twitter/X-style share control for a public post — icon trigger with
 * Copy link + Share on X. Used on the timeline feed and the /share page.
 */
export function PostShareButton({
  url,
  title,
}: {
  /** Relative or absolute post URL, e.g. `/share/abc`. */
  url: string;
  title: string;
}) {
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(absoluteUrl(url));
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  const shareOnX = () => {
    const intent = new URL('https://x.com/intent/tweet');
    intent.searchParams.set('url', absoluteUrl(url));
    const text = title.trim();
    if (text) intent.searchParams.set('text', text);
    window.open(intent.toString(), '_blank', 'noopener,noreferrer');
  };

  return (
    <DropdownMenu
      className="post-share"
      hasChevron={false}
      menuWidth="11rem"
      button={{
        label: 'Share post',
        icon: <Share2 size={16} aria-hidden="true" />,
        variant: 'ghost',
        size: 'sm',
        isIconOnly: true,
        tooltip: 'Share',
      }}
      items={[
        {
          label: 'Copy link',
          icon: <Link2 size={16} aria-hidden="true" />,
          onClick: () => {
            void copyLink();
          },
        },
        {
          label: 'Share on X',
          icon: <X size={16} aria-hidden="true" />,
          onClick: shareOnX,
        },
      ]}
    />
  );
}
