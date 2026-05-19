"use client";

import ReactMarkdown from "react-markdown";

// Whitelist of HAST element names we render. Anything outside this set is
// dropped (including `script`/`iframe`/`object`/`embed`/`style`/`form`/etc.).
// Raw HTML in markdown is also ignored because we never attach `rehype-raw`.
// Keep this list conservative; agents render user-adjacent content here.
const ALLOWED_ELEMENTS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul"
];

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown allowedElements={ALLOWED_ELEMENTS} unwrapDisallowed>
      {children}
    </ReactMarkdown>
  );
}
