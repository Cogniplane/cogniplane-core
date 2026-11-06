// A `visualViewport` that a test shrinks, as the on-screen keyboard of a phone
// does. CopilotChat reads the keyboard from it: the keyboard height is the
// window height minus `visualViewport.height`, and the chat hands that height
// to its message box slot when it is more than 150px. jsdom has no
// `visualViewport`, so a test installs this before it renders the chat.

import { act } from "@testing-library/react";
import { vi } from "vitest";

type ViewportPosition = { offsetTop?: number; scale?: number; chatBottom?: number };

export type KeyboardViewport = {
  /** The keyboard covers the bottom `height` pixels of the window. */
  open: (height: number, position?: ViewportPosition) => void;
  close: () => void;
  /** Takes the stub away. Call it in `afterEach`. */
  uninstall: () => void;
};

export function installKeyboardViewport(): KeyboardViewport {
  const target = new EventTarget();
  let covered = 0;
  let position: ViewportPosition = {};
  const previousViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  // jsdom supplies no chat geometry. Other elements keep their usual stubs.
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "copilot-chat"
      ? new DOMRect(0, 0, window.innerWidth, position.chatBottom ?? window.innerHeight)
      : originalRect.call(this);
  });
  Object.defineProperty(target, "height", { get: () => window.innerHeight - covered });
  Object.defineProperty(target, "offsetTop", { get: () => position.offsetTop ?? 0 });
  Object.defineProperty(target, "scale", { get: () => position.scale ?? 1 });
  Object.defineProperty(window, "visualViewport", { value: target, configurable: true });
  const set = (height: number, nextPosition: ViewportPosition = {}) => {
    covered = height;
    position = nextPosition;
    act(() => { target.dispatchEvent(new Event("resize")); });
  };
  return {
    open: set,
    close: () => set(0),
    uninstall: () => {
      bounds.mockRestore();
      if (previousViewport) Object.defineProperty(window, "visualViewport", previousViewport);
      else Reflect.deleteProperty(window, "visualViewport");
    }
  };
}
