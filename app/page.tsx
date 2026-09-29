import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth";
import { DEFAULT_AUTHENTICATED_PATH, LOGIN_PATH } from "@/lib/routes";

export default async function Home() {
  const user = await getSessionUser();
  redirect(user ? DEFAULT_AUTHENTICATED_PATH : LOGIN_PATH);
}
