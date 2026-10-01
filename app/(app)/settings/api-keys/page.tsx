import { KeyRoundIcon } from "lucide-react";

import { ApiKeysManager } from "@/components/settings/api-keys-manager";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { listApiKeys } from "@/lib/api-keys/service";
import { listStores } from "@/lib/data/stores";
import { hasPermission, requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "API keys" };
export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx, "manageWorkspace")) {
    return (
      <>
        <PageHeader title="API keys" description="Credentials for n8n and other automations." />
        <EmptyState
          icon={KeyRoundIcon}
          title="Owners and admins only"
          description="Ask a workspace owner or admin to manage API keys."
        />
      </>
    );
  }

  const [keys, stores] = await Promise.all([
    listApiKeys(ctx.user.id, ctx.workspace.workspaceId),
    listStores(ctx.workspace.workspaceId),
  ]);

  return (
    <>
      <PageHeader
        title="API keys"
        description="Credentials that let n8n call the Product Image Sync API. They never give access to Shopify, Google or the database."
      />
      <ApiKeysManager
        workspaceName={ctx.workspace.workspaceName}
        stores={stores.map((s) => ({ id: s.id, name: s.name }))}
        keys={keys}
      />
    </>
  );
}
