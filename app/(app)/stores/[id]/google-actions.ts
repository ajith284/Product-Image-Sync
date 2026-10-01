"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { startGoogleOAuth } from "@/lib/google/auth";
import { disconnectGoogle, verifyGoogleConnection } from "@/lib/google/connection";
import { getGoogleDeps, logGoogleError, toGoogleFlowError } from "@/lib/google/runtime";
import { authorizeStoreManager } from "@/lib/stores/authorize";

export type GoogleActionState = { ok?: boolean; message?: string; error?: string } | undefined;

const authorizeStore = (storeId: string) =>
  authorizeStoreManager(storeId, "Only workspace owners and admins can manage the Google Drive connection.");

export async function connectGoogleDrive(storeId: string): Promise<GoogleActionState> {
  const auth = await authorizeStore(storeId);
  if ("error" in auth) return { error: auth.error };

  let url: string;
  try {
    url = await startGoogleOAuth({ userId: auth.ctx.user.id, storeId }, getGoogleDeps());
  } catch (error) {
    logGoogleError("start", error);
    return { error: toGoogleFlowError(error, storeId).userMessage };
  }
  redirect(url); // to https://accounts.google.com/o/oauth2/v2/auth
}

export async function verifyGoogleDrive(storeId: string): Promise<GoogleActionState> {
  const auth = await authorizeStore(storeId);
  if ("error" in auth) return { error: auth.error };
  try {
    const result = await verifyGoogleConnection(storeId, getGoogleDeps(), { log: true });
    revalidatePath(`/stores/${storeId}`);
    return result.ok
      ? { ok: true, message: `Google Drive is connected${result.email ? ` (${result.email})` : ""}. Everything looks good.` }
      : { error: result.message };
  } catch (error) {
    logGoogleError("verify", error);
    return { error: toGoogleFlowError(error, storeId).userMessage };
  }
}

export async function disconnectGoogleDrive(storeId: string): Promise<GoogleActionState> {
  const auth = await authorizeStore(storeId);
  if ("error" in auth) return { error: auth.error };
  try {
    await disconnectGoogle(storeId, auth.ctx.user.id, getGoogleDeps());
    revalidatePath(`/stores/${storeId}`);
    return { ok: true, message: "Google Drive disconnected. Your sync history was kept." };
  } catch (error) {
    logGoogleError("disconnect", error);
    return { error: toGoogleFlowError(error, storeId).userMessage };
  }
}
