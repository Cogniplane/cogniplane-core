"use client";

import { useCallback, useSyncExternalStore } from "react";
import { toast } from "sonner";

/**
 * The app theme. `public/theme-init.js` applies the saved theme before the
 * first paint; this module reads and changes it afterwards. The `data-theme`
 * attribute on <html> is the source of truth, so every control that shows the
 * theme (header toggle, account menu) stays in step. The theme stays light
 * unless the person picks dark: the app does not follow the system setting.
 */
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  // Another tab changed the saved theme: apply it here as well.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    applyTheme(event.newValue === "dark" ? "dark" : "light");
  };
  window.addEventListener("storage", onStorage);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The saved theme, read as `public/theme-init.js` reads it. A page that renders
 * its own <html> (the global error page) applies it again, because React
 * removes the attributes that the script set.
 */
export function readSavedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * Applies the theme now and saves it for later visits. If the browser blocks
 * storage (private mode, quota, policy), the theme still applies to this page
 * and the person is told that it will not be kept.
 */
export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    toast.warning("Theme changed for this page only", {
      id: "theme-not-saved",
      description: "Your browser blocked saving the setting, so the next page you open uses the previous theme."
    });
  }
}

/** The current theme, or `null` before hydration, when it is not known yet. */
export function useTheme(): { theme: Theme | null; setTheme: (theme: Theme) => void; toggleTheme: () => void } {
  const theme = useSyncExternalStore<Theme | null>(subscribe, currentTheme, () => null);
  const toggleTheme = useCallback(() => setTheme(currentTheme() === "dark" ? "light" : "dark"), []);
  return { theme, setTheme, toggleTheme };
}
