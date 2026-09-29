/**
 * Public (browser-safe) configuration.
 *
 * Only values that are safe to ship to the browser may live here.
 * Secrets belong in `env.server.ts` and must never use the NEXT_PUBLIC_ prefix.
 */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
} as const;

export const hasSupabaseEnv = Boolean(
  publicEnv.supabaseUrl && publicEnv.supabasePublishableKey,
);

export function requirePublicEnv() {
  if (!hasSupabaseEnv) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env.local.",
    );
  }
  return publicEnv;
}
