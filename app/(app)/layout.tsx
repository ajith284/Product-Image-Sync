import { AppHeader } from "@/components/layout/app-header";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { requireUser } from "@/lib/auth";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // Defense in depth: the proxy redirects early, but every protected render verifies too.
  const user = await requireUser();

  return (
    <SidebarProvider>
      <AppSidebar email={user.email} />
      <SidebarInset>
        <AppHeader />
        <main className="flex flex-1 flex-col gap-6 p-4 md:p-8">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
