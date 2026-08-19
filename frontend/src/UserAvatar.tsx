import { ProfileSunglasses } from './Sunglasses';
import { api } from './api';

/**
 * Round profile photo — custom upload when set, otherwise the brand sunglasses
 * mark (never the Google OAuth picture).
 */
export function UserAvatar({
  avatarUrl,
  className,
  alt = '',
}: {
  avatarUrl?: string | null;
  className?: string;
  alt?: string;
}) {
  const src = api.avatarSrc(avatarUrl);
  if (src) {
    return (
      <img
        key={src}
        src={src}
        alt={alt}
        className={className}
        width={56}
        height={56}
        decoding="async"
      />
    );
  }
  return <ProfileSunglasses className={className} />;
}
