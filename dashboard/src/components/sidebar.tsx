"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  CalendarClock,
  FileText,
  GitBranch,
  LayoutDashboard,
  Plug,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck },
  { href: "/repositories", label: "Repositories", icon: GitBranch },
  { href: "/prompts", label: "Prompts", icon: FileText },
  { href: "/skills", label: "Skills", icon: Sparkles },
  { href: "/mcps", label: "MCPs", icon: Plug },
  { href: "/nodes", label: "Nodes", icon: CalendarClock },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex size-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground shadow-sm">
          <Bot className="size-5" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">open-agent</div>
          <div className="text-xs text-muted-foreground">admin console</div>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 px-3 py-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )}
            >
              <Icon className={cn("size-4", active && "text-sidebar-primary")} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="px-5 py-4 text-[11px] text-muted-foreground/70">
        Slack coworker · Codex engine
      </div>
    </aside>
  );
}
