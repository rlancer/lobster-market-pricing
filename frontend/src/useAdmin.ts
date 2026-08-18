import { authClient } from './auth';
import { isAdminEmail } from './admin';

/** Session-based admin check for nav + page gates. */
export function useIsAdmin(): { isAdmin: boolean; isPending: boolean } {
  const { data: session, isPending } = authClient.useSession();
  return {
    isPending,
    isAdmin: isAdminEmail(session?.user?.email),
  };
}
