import { ActivityFeed } from "@/components/activity/activity-feed";
import { listActivity } from "@/lib/data/sync";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Activity" };

export default async function Page() {
  const ctx = await requireWorkspace();
  const activity = await listActivity(ctx.workspace.workspaceId, 1000);

  return (
    <div className="w-full md:relative md:left-1/2 md:w-[calc(100vw-var(--sidebar-width)-2rem)] md:max-w-[1600px] md:-translate-x-1/2">
      <ActivityFeed items={activity} />
    </div>
  );
}
