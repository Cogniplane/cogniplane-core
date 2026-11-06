"use client";

import SyntaxHighlighter from "react-syntax-highlighter";

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
    <div className="artifact-code-scroll" tabIndex={0} role="region" aria-label="Code preview">
      <SyntaxHighlighter
        language={language}
        useInlineStyles={false}
        wrapLongLines
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
