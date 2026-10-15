"use client";

import { useEffect, useState } from "react";

import { SHORTCUTS, shortcutKeys, useApplePlatform, useShortcut } from "../lib/keyboard-shortcuts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

const OPEN_EVENT = "cogniplane:keyboard-shortcuts";
const KBD = "rounded border border-outline-variant bg-surface-container-low px-1.5 py-px font-mono text-[0.68rem] text-on-surface-variant";

/** Opens the shortcuts dialog from a menu item. */
export function openKeyboardShortcuts(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Lists every shortcut. "?" opens it. The root layout mounts it once. */
export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const apple = useApplePlatform();
  useShortcut(SHORTCUTS.help, () => setOpen(true));
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  const shortcuts = Object.values(SHORTCUTS);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts do not work while another dialog or menu is open.</DialogDescription>
        </DialogHeader>
        {(["Everywhere", "Chat"] as const).map((scope) => (
          <section key={scope} aria-labelledby={`shortcuts-${scope}`}>
            <h3 id={`shortcuts-${scope}`} className="pb-1 text-xs font-semibold text-on-surface-variant">{scope}</h3>
            <dl className="divide-y divide-outline-variant">
              {shortcuts.filter((shortcut) => shortcut.scope === scope).map((shortcut) => (
                <div key={shortcut.label} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <dt className="text-on-surface">{shortcut.label}</dt>
                  <dd className="flex shrink-0 gap-1">
                    {shortcutKeys(shortcut, apple).map((key) => <kbd key={key} className={KBD}>{key}</kbd>)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}
