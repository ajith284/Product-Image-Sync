/** Maps Supabase auth errors to customer-friendly messages. Never echoes raw provider errors. */
export function friendlyAuthError(code: string | undefined, fallback: string): string {
  switch (code) {
    case "invalid_credentials":
      return "That email and password don't match. Please try again.";
    case "email_not_confirmed":
      return "Please confirm your email first. Check your inbox for the link.";
    case "user_already_exists":
    case "email_exists":
      return "An account with this email already exists. Try signing in.";
    case "weak_password":
      return "Please choose a stronger password.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Too many attempts. Please wait a minute and try again.";
    case "signup_disabled":
      return "New sign-ups are currently disabled.";
    default:
      return fallback;
  }
}
