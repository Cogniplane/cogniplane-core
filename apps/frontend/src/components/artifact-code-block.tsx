"use client";

import SyntaxHighlighter from "react-syntax-highlighter";
import { atomOneDark } from "react-syntax-highlighter/dist/esm/styles/hljs";

// Isolated so next/dynamic can split react-syntax-highlighter (+ its hljs
// grammars) out of the main chat bundle. Rendered only by ArtifactPreviewModal's
// code-fallback branch.
export default function ArtifactCodeBlock({
  language,
  code
}: {
  language: string;
  code: string;
}) {
  return (
    <SyntaxHighlighter
      language={language}
      style={atomOneDark}
      customStyle={{ margin: 0, borderRadius: 4, fontSize: "0.85rem", lineHeight: 1.6 }}
      wrapLongLines
    >
      {code}
    </SyntaxHighlighter>
  );
}
