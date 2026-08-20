/**
 * Admin user directory — every Better Auth identity that has signed in,
 * joined to the optional product profile (handle / display name).
 */
import { avatarUrlFor } from "./avatars";
import { isAdminEmail } from "./admin";
import { publicName } from "./profiles";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  image: string | null;
  emailVerified: number | boolean | null;
  createdAt: string | number | Date;
  handle: string | null;
  display_name: string | null;
  avatar_key: string | null;
  profile_updated_at: number | null;
  profile_created_at: number | null;
  chat_count: number | null;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  /** Google OAuth picture URL (may be null). */
  image: string | null;
  email_verified: boolean;
  created_at: string;
  handle: string | null;
  display_name: string | null;
  /** Public display name (product display_name or Google name). */
  public_name: string;
  avatar_url: string | null;
  profile_created_at: number | null;
  chat_count: number;
  is_admin: boolean;
}

export function clampUserListLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

/** Normalize Better Auth DATE / epoch / Date into an ISO string. */
export function normalizeAuthCreatedAt(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && /^\d+(\.\d+)?$/.test(trimmed)) {
      return normalizeAuthCreatedAt(asNum);
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    return trimmed;
  }
  return "";
}

export function rowToAdminUser(row: AdminUserRow): AdminUser {
  const display_name = row.display_name?.trim() || null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image ?? null,
    email_verified: Boolean(row.emailVerified),
    created_at: normalizeAuthCreatedAt(row.createdAt),
    handle: row.handle ?? null,
    display_name,
    public_name: publicName(display_name, row.name),
    avatar_url: avatarUrlFor(row.id, row.avatar_key, row.profile_updated_at),
    profile_created_at: row.profile_created_at ?? null,
    chat_count: Number(row.chat_count ?? 0) || 0,
    is_admin: isAdminEmail(row.email),
  };
}

export async function listAdminUsers(
  db: D1Database,
  opts?: { limit?: number },
): Promise<AdminUser[]> {
  const limit = clampUserListLimit(opts?.limit);
  const result = await db
    .prepare(
      `SELECT
         u.id AS id,
         u.email AS email,
         u.name AS name,
         u.image AS image,
         u.emailVerified AS emailVerified,
         u.createdAt AS createdAt,
         p.handle AS handle,
         p.display_name AS display_name,
         p.avatar_key AS avatar_key,
         p.updated_at AS profile_updated_at,
         p.created_at AS profile_created_at,
         (
           SELECT COUNT(*)
           FROM user_chats c
           WHERE c.user_id = u.id AND c.deleted_at IS NULL
         ) AS chat_count
       FROM "user" u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       ORDER BY u.createdAt DESC
       LIMIT ?1`,
    )
    .bind(limit)
    .all<AdminUserRow>();
  return (result.results ?? []).map(rowToAdminUser);
}
