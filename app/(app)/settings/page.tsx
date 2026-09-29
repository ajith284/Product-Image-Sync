import { SettingsIcon } from "lucide-react";

import { ComingSoon } from "@/components/shared/coming-soon";
import { PageHeader } from "@/components/shared/page-header";

export const metadata = { title: "Settings" };

export default function Page() {
  return (
    <>
      <PageHeader title="Settings" description="Workspace and account settings." />
      <ComingSoon icon={SettingsIcon} text="Workspace, team member and sync preference settings will be available here." />
    </>
  );
}
