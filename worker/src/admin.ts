/**
 * Product admin allowlist (Google sign-in emails). Keep in sync with
 * `frontend/src/admin.ts`. Start with a single owner; grow the list later.
 */
export const ADMIN_EMAILS = ["robert.lancer@gmail.com"] as const;

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return (ADMIN_EMAILS as readonly string[]).includes(normalized);
}
