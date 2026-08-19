import { useEffect, useState } from 'react';
import { DropdownMenu } from '@astryxdesign/core';
import { Link2, Share2, Upload } from 'lucide-react';

/** Resolve a relative Worker path (e.g. `/share/abc`) to an absolute URL. */
function absoluteUrl(pathOrUrl: string): string {
  return new URL(pathOrUrl, window.location.href).toString();
}

/**
 * Share control for a public post — icon trigger with Copy link and
 * Share via… (system share sheet when available). Used on the timeline
 * feed and the /share page.
 */
export function PostShareButton({
  url,
  title,
}: {
  /** Relative or absolute post URL, e.g. `/share/abc`. */
  url: string;
  title: string;
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
