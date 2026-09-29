import "server-only";

import { z } from "zod";

/**
 * Server-only environment variables. Importing this file from a Client
 * Component fails the build, so secrets added here can never reach the browser.
 *
 * Empty in the foundation phase. Later phases add their variables to this
 * schema (never with a NEXT_PUBLIC_ prefix) and to .env.example by name only.
 */
const serverEnvSchema = z.object({});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (!cached) {
    const parsed = serverEnvSchema.safeParse(process.env);
    if (!parsed.success) {
      // Report which variables are invalid, never their values.
      const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid server environment variables: ${names}`);
    }
    cached = parsed.data;
  }
  return cached;
}
