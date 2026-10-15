"use client";

import Link from "next/link";

import { useAuth } from "../lib/auth-context";
import { useOrganizations } from "../hooks/use-organizations";
import { openKeyboardShortcuts } from "./keyboard-shortcuts-dialog";
import { QuickJump } from "./quick-jump/quick-jump";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

type MenuLink = {
  href: string;
  label: string;
  description: string;
};

function avatarInitials(name: string | undefined, email: string | undefined): string {
  const source = (name ?? email ?? "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function ConsolePageHeader(props: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  menuLinks: MenuLink[];
}) {
  const { user, login, logout } = useAuth();
  const organizations = useOrganizations(Boolean(user));
  const currentSlug = user?.tenantSlug?.toLowerCase();
  const otherOrganizations = organizations.filter((org) => org.id.toLowerCase() !== currentSlug);
  const initials = avatarInitials(user?.displayName, user?.email);

  return (
    // On narrow screens the controls share the eyebrow row, and the title and subtitle span both columns.
    // From sm up, the controls span the eyebrow and title rows, as in a two-column header.
    <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-outline-variant bg-surface-container-lowest px-6 py-5 sm:items-start">
      <p className="col-start-1 row-start-1 min-w-0 text-[0.62rem] font-bold uppercase tracking-[0.14em] text-brand">
        {props.eyebrow}
      </p>
      <h1 className="col-span-2 row-start-2 min-w-0 text-2xl font-semibold tracking-tight text-on-surface sm:col-span-1">
        {props.title}
      </h1>
      {props.subtitle ? (
        <p className="col-span-2 row-start-3 mt-1 max-w-2xl text-sm text-on-surface-variant sm:col-span-1">{props.subtitle}</p>
      ) : null}

      <div className="col-start-2 row-start-1 flex items-center gap-2 sm:row-span-2">
        <QuickJump />
        <ThemeToggle />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open workspace menu"
              className="rounded-full"
            >
              <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {initials}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {props.menuLinks.map((link) => (
              <DropdownMenuItem key={link.href} asChild>
                <Link href={link.href} className="flex flex-col items-start gap-0.5">
                  <span className="font-medium">{link.label}</span>
                  <span className="text-xs text-muted-foreground">{link.description}</span>
                </Link>
              </DropdownMenuItem>
            ))}
            {otherOrganizations.length > 0 ? <DropdownMenuSeparator /> : null}
            {otherOrganizations.map((org) => (
              <DropdownMenuItem
                key={org.id}
                onSelect={() => void login({ organization: org.id })}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="font-medium">Switch to {org.name}</span>
                <span className="text-xs text-muted-foreground">Sign in to this organization</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openKeyboardShortcuts} className="flex flex-col items-start gap-0.5">
              <span className="font-medium">Keyboard shortcuts</span>
              <span className="text-xs text-muted-foreground">Press ? on any page</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void logout()}
              className="flex flex-col items-start gap-0.5"
            >
              <span className="font-medium">Log out</span>
              <span className="text-xs text-muted-foreground">End this session and return to login</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
