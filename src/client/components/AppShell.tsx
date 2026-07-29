import {
  Database,
  Mail,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "../lib/router";
import { Tooltip } from "./ui";

const navigation = [
  { to: "/discover", label: "Discover", icon: Search },
  { to: "/review", label: "Review", icon: ShieldCheck },
  { to: "/outreach", label: "Outreach", icon: Mail },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark">
            <Sparkles size={17} aria-hidden="true" />
          </span>
          <div>
            <strong>RecruitAI</strong>
            <span>Research desk</span>
          </div>
        </div>
        <nav aria-label="Primary">
          {navigation.map((item) => {
            const Icon = item.icon;
            const isActive =
              location === item.to || location.startsWith(`${item.to}/`);
            return (
              <Link
                aria-current={isActive ? "page" : undefined}
                className={`nav-link ${isActive ? "is-active" : ""}`}
                key={item.to}
                to={item.to}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar__footer">
          <Tooltip label="All prospect data stays in your local data folder.">
            <div className="local-state">
              <Database size={16} aria-hidden="true" />
              <span>Local SQLite</span>
            </div>
          </Tooltip>
        </div>
      </aside>
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
