"use client";

import Link from "next/link";
import { useRef } from "react";
import { MoonIcon, SunIcon } from "lucide-react";

import { useAuth, type AuthUser } from "../lib/auth-context";
import { useOrganizations } from "../hooks/use-organizations";
import { useTheme } from "../lib/theme";
import { cn } from "@/lib/cn";
import { openKeyboardShortcuts } from "./keyboard-shortcuts-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

export type AccountMenuLink = {
  href: string;
  label: string;
  description: string;
};

/** Destinations that the account menu offers, in display order. */
export type AccountMenuDestination = "chat" | "artifacts" | "settings" | "admin";

const DESTINATIONS: Record<AccountMenuDestination, AccountMenuLink> = {
  chat: { href: "/", label: "Chat", description: "Return to the active workspace" },
  artifacts: { href: "/artifacts", label: "Artifacts", description: "Browse files across all sessions" },
  settings: { href: "/settings", label: "Settings", description: "Your accounts, skills, and scheduled jobs" },
  admin: { href: "/admin", label: "Admin", description: "Organization models, people, and policies" }
};

/**
 * Admin is a destination only for owners and admins. This filter only hides a
 * link that would end in a redirect. AuthGuard and the backend still decide
 * who may open an admin page.
 */
export function canOpenAdmin(role: AuthUser["role"] | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function accountMenuLinks(
  destinations: readonly AccountMenuDestination[],
  role: AuthUser["role"] | undefined
): AccountMenuLink[] {
  return destinations
    .filter((destination) => destination !== "admin" || canOpenAdmin(role))
    .map((destination) => DESTINATIONS[destination]);
}

export function avatarInitials(name: string | undefined, email: string | undefined): string {
  const source = (name ?? email ?? "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/** The account and workspace menu, shared by the workspace and console headers. */
export function AccountMenu(props: {
  destinations: readonly AccountMenuDestination[];
  /** Show a theme item. Headers that hide their theme toggle set this. */
  includeTheme?: boolean;
  triggerClassName?: string;
}) {
  const { user, login, logout } = useAuth();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const shortcutsAfterClose = useRef(false);
  const organizations = useOrganizations(Boolean(user));
  const { theme, toggleTheme } = useTheme();
  const currentSlug = user?.tenantSlug?.toLowerCase();
  const otherOrganizations = organizations.filter((org) => org.id.toLowerCase() !== currentSlug);
  const links = accountMenuLinks(props.destinations, user?.role);
  const initials = avatarInitials(user?.displayName, user?.email);
  const name = user?.displayName?.trim() || user?.email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={name ? `Open account menu for ${name}` : "Open account menu"}
          className={cn("rounded-full", props.triggerClassName)}
        >
          <span
            aria-hidden="true"
            className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
          >
            {initials}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72" onCloseAutoFocus={(event) => {
        if (!shortcutsAfterClose.current) return;
        event.preventDefault();
        shortcutsAfterClose.current = false;
        triggerRef.current?.focus();
        openKeyboardShortcuts();
      }}>
        {name ? (
          <>
            <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
              <span className="truncate text-sm font-semibold text-on-surface">{name}</span>
              {user?.email && user.email !== name ? (
                <span className="truncate text-xs text-on-surface-variant">{user.email}</span>
              ) : null}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {links.map((link) => (
          // Layout classes go on the item, where cn() merges them; on the Link,
          // Slot would append them next to the item's own gap.
          <DropdownMenuItem key={link.href} asChild className="flex flex-col items-start gap-0.5">
            <Link href={link.href}>
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
        {props.includeTheme && theme !== null ? (
          <DropdownMenuItem onSelect={toggleTheme}>
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            {theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => { shortcutsAfterClose.current = true; }} className="flex flex-col items-start gap-0.5">
          <span className="font-medium">Keyboard shortcuts</span>
          <span className="text-xs text-muted-foreground">Press ? on any page</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void logout()} className="flex flex-col items-start gap-0.5">
          <span className="font-medium">Log out</span>
          <span className="text-xs text-muted-foreground">End this session and return to login</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
