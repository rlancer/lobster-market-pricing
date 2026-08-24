/**
 * UI admin allowlist. Keep in sync with `worker/src/admin.ts` — the Worker is
 * the source of truth for `is_admin` on GET /api/me; the client mirrors it so
 * nav gating does not wait on a round-trip.
 */
export const ADMIN_EMAILS = ['robert.lancer@gmail.com'] as const;

/** Admin-only page paths (hub is `/admin`; tools stay at these URLs). */
export const ADMIN_TOOL_PATHS = ['/bots', '/users', '/chats', '/trades', '/copilot', '/brand', '/notebooks'] as const;

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return (ADMIN_EMAILS as readonly string[]).includes(normalized);
}

/** True for `/admin` or any admin tool route (used for left-nav selection). */
export function isAdminNavPath(pathname: string): boolean {
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return true;
  return ADMIN_TOOL_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/** True for `/notebooks` and notebook detail routes (own left-nav highlight). */
export function isNotebooksNavPath(pathname: string): boolean {
  return pathname === '/notebooks' || pathname.startsWith('/notebooks/');
}
