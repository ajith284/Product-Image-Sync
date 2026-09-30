import { AppHeader } from "@/components/layout/header";
import { AppSidebar } from "@/components/layout/sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { requireWorkspace } from "@/lib/workspace";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // Server-side: session → workspace membership. The proxy redirects early,
  // but every protected render verifies again; RLS is the final check.
  const { user, memberships, workspace } = await requireWorkspace();
  const menuUser = { fullName: user.fullName, email: user.email };

  return (
    <SidebarProvider>
      <AppSidebar user={menuUser} memberships={memberships} workspace={workspace} />
      <SidebarInset>
        <AppHeader user={menuUser} workspace={workspace} />
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 md:p-8">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
