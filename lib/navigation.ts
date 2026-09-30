import {
  ActivityIcon,
  FolderTreeIcon,
  InboxIcon,
  LayoutDashboardIcon,
  RefreshCwIcon,
  SettingsIcon,
  StoreIcon,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
};

export const mainNav: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboardIcon },
  { title: "Stores", href: "/stores", icon: StoreIcon },
  { title: "Drive Mapping", href: "/drive-mapping", icon: FolderTreeIcon },
  { title: "Sync Jobs", href: "/sync-jobs", icon: RefreshCwIcon },
  { title: "Review", href: "/review", icon: InboxIcon },
  { title: "Activity", href: "/activity", icon: ActivityIcon },
  { title: "Settings", href: "/settings", icon: SettingsIcon },
];

export function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Title shown in the header for the current path. */
export function pageTitle(pathname: string): string {
  if (pathname === "/stores/new") return "Add store";
  if (/^\/stores\/[^/]+$/.test(pathname)) return "Store details";
  return mainNav.find((item) => isActive(pathname, item.href))?.title ?? "Product Image Sync";
}
