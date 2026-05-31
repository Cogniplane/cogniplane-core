import Link from "next/link";

import type { NavigationItem } from "@cogniplane/shared-types";

export function ConsoleNavigation(input: {
  sectionLabel: string;
  ariaLabel: string;
  activeSectionId: string;
  navigationItems: readonly NavigationItem[];
  basePath: string;
}) {
  const { sectionLabel, ariaLabel, activeSectionId, navigationItems, basePath } = input;

  return (
    <aside className="flex flex-col gap-1 border-r border-outline-variant bg-surface-container-low px-3 py-4">
      <p className="px-3 pb-2 text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint">
        {sectionLabel}
      </p>

      <nav className="flex flex-col gap-0.5" aria-label={ariaLabel}>
        {navigationItems.map((item) => {
          const isActive = item.id === activeSectionId;
          return (
            <Link
              key={item.id}
              href={`${basePath}/${item.id}`}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-surface-container font-medium text-on-surface"
                  : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
              }`}
            >
              <span>{item.label}</span>
              {typeof item.count === "number" ? (
                <span className="text-xs text-on-surface-faint">{item.count}</span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
