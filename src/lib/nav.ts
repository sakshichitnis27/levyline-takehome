import {
  FileUpIcon,
  InboxIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  UsersIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  description: string;
  exact?: boolean;
};

export type NavGroup = { label: string; items: NavItem[] };

// One place for the app's routes; the sidebar reads from this.
export const navGroups: NavGroup[] = [
  {
    label: "Levyline",
    items: [
      { title: "Today", href: "/", icon: LayoutDashboardIcon, description: "What needs attention", exact: true },
      { title: "Owners", href: "/owners", icon: UsersIcon, description: "Every owner and their balance" },
      { title: "Automations", href: "/automations", icon: WorkflowIcon, description: "Reminder emails on a canvas" },
      { title: "Unmatched replies", href: "/inbox", icon: InboxIcon, description: "Replies to attach to an owner" },
      { title: "Import", href: "/import", icon: FileUpIcon, description: "Upload an export from the accounts system" },
    ],
  },
  {
    label: "Development",
    items: [{ title: "Settings", href: "/settings", icon: SettingsIcon, description: "App clock and email mode" }],
  },
];

export const navItems = navGroups.flatMap((group) => group.items);
