import { PostMessageTransport } from "@modelcontextprotocol/ext-apps";

type MessageListener = (event: MessageEvent) => void;

/**
 * The host side of the bridge to the sandbox proxy. ext-apps
 * PostMessageTransport checks `event.source` and sends with the target origin
 * "*". This subclass also drops a message whose `event.origin` is not the
 * sandbox origin, and sends only to that origin. It keeps the JSON-RPC
 * validation, `start`, and `close` of the base class.
 *
 * The base class keeps its message handler in the private field
 * `messageListener`, and `start` registers it. The class has no public hook for
 * the origin, so the constructor wraps that handler. If a later ext-apps
 * version moves the field, the constructor throws, and the bridge does not run
 * without the origin check.
 */
export class OriginBoundPostMessageTransport extends PostMessageTransport {
  private readonly peer: Window;
  private readonly peerOrigin: string;

  constructor(peer: Window, peerOrigin: string) {
    super(peer, peer);
    this.peer = peer;
    this.peerOrigin = peerOrigin;
    const guarded = this as unknown as { messageListener?: MessageListener };
    const baseListener = guarded.messageListener;
    if (typeof baseListener !== "function") {
      throw new Error("The MCP App transport cannot check message origins.");
    }
    guarded.messageListener = (event) => {
      if (event.origin !== peerOrigin) return;
      baseListener(event);
    };
  }

  override async send(message: Parameters<PostMessageTransport["send"]>[0]): Promise<void> {
    this.peer.postMessage(message, this.peerOrigin);
  }
}
