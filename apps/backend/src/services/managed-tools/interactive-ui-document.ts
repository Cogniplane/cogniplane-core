import { MCP_APP_MESSAGE_MAX_CHARS } from "@cogniplane/shared-types";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]!);
}

// The iframe sandbox and host enforce permissions. This bridge only speaks MCP Apps.
// sendMessage asks the host to put a draft in the chat message box. The host
// refuses more than the same number of characters, so the shell checks it first.
const bridgeScript = String.raw`
(() => {
  let ready = false;
  let closed = false;
  let sequence = 1;
  let pending = null;
  let observer;
  const initializeId = 'cogniplane-initialize';
  const send = (message) => window.parent.postMessage({jsonrpc:'2.0', ...message}, '*');
  const theme = (context) => {
    if (context?.theme === 'light' || context?.theme === 'dark') {
      document.documentElement.dataset.theme = context.theme;
    }
  };
  const cancel = () => {
    ready = false;
    closed = true;
    clearTimeout(timeout);
    observer?.disconnect();
    pending?.resolve({isError:true});
    pending = null;
  };
  const timeout = setTimeout(() => { if (!ready) cancel(); }, 10000);
  window.cogniplane = Object.freeze({sendMessage(text) {
    if (!ready || closed || pending || typeof text !== 'string' || !text.trim() || text.length > ${MCP_APP_MESSAGE_MAX_CHARS}) {
      return Promise.resolve({isError:true});
    }
    return new Promise((resolve) => {
      const id = 'cogniplane-message-' + sequence++;
      pending = {id, resolve};
      send({id, method:'ui/message', params:{role:'user', content:[{type:'text', text}]}});
    });
  }});
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0' || closed) return;
    const message = event.data;
    if (message.id === initializeId && !ready) {
      if (message.error || !message.result?.protocolVersion) { cancel(); return; }
      clearTimeout(timeout);
      theme(message.result.hostContext);
      ready = true;
      send({method:'ui/notifications/initialized', params:{}});
      resize();
    } else if (pending && message.id === pending.id) {
      const request = pending;
      pending = null;
      request.resolve(message.error || !message.result || message.result.isError ? {isError:true} : {});
    } else if (message.method === 'ui/notifications/host-context-changed') {
      theme(message.params);
    } else if (message.method === 'ping' && message.id !== undefined) {
      send({id:message.id, result:{}});
    } else if (message.method === 'ui/resource-teardown' && message.id !== undefined) {
      send({id:message.id, result:{}});
      cancel();
    }
  });
  let lastHeight;
  const resize = () => {
    const content = document.getElementById('cogniplane-content');
    if (!ready || !content) return;
    const height = Math.ceil(content.getBoundingClientRect().height);
    if (height !== lastHeight) {
      lastHeight = height;
      send({method:'ui/notifications/size-changed', params:{height}});
    }
  };
  document.addEventListener('DOMContentLoaded', () => {
    const content = document.getElementById('cogniplane-content');
    if (content && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(resize);
      observer.observe(content);
    }
    resize();
  });
  window.addEventListener('pagehide', cancel, {once:true});
  send({id:initializeId, method:'ui/initialize', params:{
    protocolVersion:'2026-01-26', appInfo:{name:'Cogniplane interactive UI', version:'1.0.0'}, appCapabilities:{}
  }});
})();`;

export function renderInteractiveUiDocument(input: { title: string; description: string; html: string }): string {
  return `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
:root{color-scheme:light;--background:#fff;--foreground:#17202a;--muted:#596573;--border:#d5dce3;--primary:#355dc9}
:root[data-theme="dark"]{color-scheme:dark;--background:#171c24;--foreground:#eef2f6;--muted:#a7b3c2;--border:#3b4655;--primary:#a7baff}
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:15px/1.5 system-ui,sans-serif}
#cogniplane-content{padding:20px;overflow-wrap:anywhere}
.cogniplane-heading{margin:0 0 8px;font:600 20px/1.3 system-ui,sans-serif}
.cogniplane-summary{margin:0 0 20px;color:var(--muted)}
button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:default}
button,input,select,textarea{max-width:100%}svg,canvas,img{max-width:100%}
:focus-visible{outline:2px solid var(--primary);outline-offset:3px}
</style><script>${bridgeScript}</script></head>
<body><main id="cogniplane-content"><h1 class="cogniplane-heading">${escapeHtml(input.title)}</h1>
<p class="cogniplane-summary">${escapeHtml(input.description)}</p>
${input.html}
</main></body></html>`;
}
