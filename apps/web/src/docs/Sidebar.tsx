import { NavLink } from "react-router-dom";
import { docs, type DocGroup } from "./docs";

const groups: DocGroup[] = ["Guide", "Reference"];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="space-y-6">
      {groups.map((group) => (
        <div key={group}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
            {group}
          </p>
          <ul className="space-y-1">
            {docs
              .filter((d) => d.group === group)
              .map((d) => (
                <li key={d.slug}>
                  <NavLink
                    to={`/docs/${d.slug}`}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `block rounded-md px-3 py-1.5 text-sm ${
                        isActive
                          ? "bg-accent/10 font-medium text-accent"
                          : "text-zinc-600 hover:text-accent dark:text-zinc-400"
                      }`
                    }
                  >
                    {d.title}
                  </NavLink>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
