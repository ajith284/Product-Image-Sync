/**
 * Customer-friendly messages for database / API errors.
 * Never show raw provider errors (codes, JWT details, SQL) to customers.
 */
export const MESSAGES = {
  sessionExpired: "Your session expired. Please log in again.",
  noAccess: "You do not have access to this workspace.",
  noPermission: "You don't have permission to do that. Ask a workspace owner or admin.",
  network: "We couldn't reach the server. Please check your connection and try again.",
  generic: "Something went wrong. Please try again.",
} as const;

type ErrorLike = { code?: string | null; message?: string | null } | null | undefined;

export function isSessionError(error: ErrorLike): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const message = (error.message ?? "").toLowerCase();
  return code === "PGRST301" || code === "PGRST303" || message.includes("jwt expired");
}

export function friendlyDbError(error: ErrorLike, fallback: string = MESSAGES.generic): string {
  if (!error) return fallback;
  if (isSessionError(error)) return MESSAGES.sessionExpired;
  switch (error.code) {
    case "42501": // insufficient_privilege / RLS violation
      return MESSAGES.noAccess;
    case "23505": // unique_violation
      return "This already exists.";
    case "23514": // check_violation
    case "22P02": // invalid_text_representation
      return "Some of the details aren't valid. Please check and try again.";
    default:
      return (error.message ?? "").toLowerCase().includes("fetch failed") ? MESSAGES.network : fallback;
  }
}
