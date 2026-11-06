"use client";

import { MoonIcon, SunIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { useTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";

/**
 * Switches between the light and dark theme. The label names the theme that
 * the button switches to.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const label = theme === null ? "Switch theme" : isDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn("text-on-surface-variant hover:text-on-surface", className)}
      aria-label={label}
      title={label}
      disabled={theme === null}
      onClick={toggleTheme}
    >
      {isDark ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
    </Button>
  );
}
