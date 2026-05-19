"use client";

import Link from "next/link";

import { useAuth } from "../lib/auth-context";
import { useOrganizations } from "../hooks/use-organizations";
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
    <header className="flex items-start justify-between gap-4 border-b border-outline-variant bg-surface-container-lowest px-6 py-5">
      <div>
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint">
          {props.eyebrow}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-on-surface">{props.title}</h1>
        {props.subtitle ? (
          <p className="mt-1 max-w-2xl text-sm text-on-surface-variant">{props.subtitle}</p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
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
