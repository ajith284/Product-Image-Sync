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
  description: string;
};

export const mainNav: NavItem[] = [
  {
    title: "Dashboard",
    href: "/dashboard",
    icon: LayoutDashboardIcon,
    description: "An overview of your stores and recent syncs.",
  },
  {
    title: "Stores",
    href: "/stores",
    icon: StoreIcon,
    description: "Connect and manage your Shopify stores.",
  },
  {
    title: "Drive Mapping",
    href: "/drive-mapping",
    icon: FolderTreeIcon,
    description: "Choose the Google Drive folders that hold your product images.",
  },
  {
    title: "Sync Jobs",
    href: "/sync-jobs",
    icon: RefreshCwIcon,
    description: "See every image sync and what it uploaded.",
  },
  {
    title: "Review Center",
    href: "/review",
    icon: InboxIcon,
    description: "Resolve products that need your attention before images can upload.",
  },
  {
    title: "Activity",
    href: "/activity",
    icon: ActivityIcon,
    description: "A readable history of everything that happened.",
  },
];

export const secondaryNav: NavItem[] = [
  {
    title: "Settings",
    href: "/settings",
    icon: SettingsIcon,
    description: "Workspace and account settings.",
  },
];
