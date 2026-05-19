"use client";

import { useState } from "react";

const CATEGORY_COLORS: Record<string, string> = {
  Productivity: "#7c3aed",
  Code: "#0ea5e9",
  Communication: "#16a34a",
  CRM: "#f59e0b"
};

function colorFor(category: string): string {
  return CATEGORY_COLORS[category] ?? "#64748b";
}

export function IntegrationLogo(props: {
  slug: string;
  name: string;
  category: string;
  size?: number;
}) {
  const size = props.size ?? 28;
  const [errored, setErrored] = useState(false);

  if (errored) {
    const letter = (props.name[0] ?? "?").toUpperCase();
    const bg = colorFor(props.category);
    return (
      <span
        aria-label={props.name}
        className="integration-logo integration-logo-fallback"
        style={{
          width: size,
          height: size,
          background: bg,
          color: "#fff",
          borderRadius: "50%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: Math.round(size * 0.5),
          fontWeight: 600,
          lineHeight: 1
        }}
      >
        {letter}
      </span>
    );
  }

  return (
    // Local SVG with an onError fallback to a colored initial; next/image doesn't optimize SVGs
    // and would swallow the load error we depend on for the fallback path.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/integrations/${props.slug}.svg`}
      alt={props.name}
      className="integration-logo"
      width={size}
      height={size}
      onError={() => setErrored(true)}
      style={{ objectFit: "contain", flexShrink: 0 }}
    />
  );
}
