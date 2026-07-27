import { useState } from "react";
import { Outlet } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Sidebar } from "./Sidebar";

export function DocsLayout() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto flex max-w-6xl gap-10 px-4 py-8">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Toggle docs menu"
        className="fixed bottom-4 right-4 z-40 rounded-full bg-accent p-3 text-zinc-950 shadow-lg lg:hidden"
      >
        <Icon name="menu" />
      </button>
      <div
        className={`${
          open ? "block" : "hidden"
        } fixed inset-0 z-30 bg-white p-6 pt-20 dark:bg-zinc-950 lg:static lg:z-0 lg:block lg:w-56 lg:shrink-0 lg:bg-transparent lg:p-0 lg:pt-0`}
      >
        <Sidebar onNavigate={() => setOpen(false)} />
      </div>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
