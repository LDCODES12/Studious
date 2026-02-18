import {
  LayoutDashboard,
  Calendar,
  Brain,
  Users,
  Upload,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export const mainNavItems: NavItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Upload", href: "/upload", icon: Upload },
  { label: "Schedule", href: "/schedule", icon: Calendar },
  { label: "Study Tools", href: "/study-tools", icon: Brain },
  { label: "Study Buddies", href: "/buddies", icon: Users },
];

export const courseColors: Record<
  string,
  { bg: string; text: string; border: string; dot: string; light: string }
> = {
  blue: {
    bg: "bg-blue-500",
    text: "text-blue-700",
    border: "border-blue-500",
    dot: "bg-blue-500",
    light: "bg-blue-50",
  },
  green: {
    bg: "bg-green-500",
    text: "text-green-700",
    border: "border-green-500",
    dot: "bg-green-500",
    light: "bg-green-50",
  },
  purple: {
    bg: "bg-purple-500",
    text: "text-purple-700",
    border: "border-purple-500",
    dot: "bg-purple-500",
    light: "bg-purple-50",
  },
  orange: {
    bg: "bg-orange-500",
    text: "text-orange-700",
    border: "border-orange-500",
    dot: "bg-orange-500",
    light: "bg-orange-50",
  },
  rose: {
    bg: "bg-rose-500",
    text: "text-rose-700",
    border: "border-rose-500",
    dot: "bg-rose-500",
    light: "bg-rose-50",
  },
};
