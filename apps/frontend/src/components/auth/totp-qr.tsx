"use client";

import { useMemo } from "react";
import { encode } from "uqr";

import { cn } from "@/lib/cn";
import { AUTH_FOCUS_RING } from "./auth-ui";

// The QR code an authenticator app scans. Drawn as SVG rectangles from the
// encoder's matrix, so no markup string is injected into the page.
export function TotpQr({ uri, size = 192 }: { uri: string; size?: number }) {
  const matrix = useMemo(() => encode(uri, { border: 2, ecc: "M" }), [uri]);
  const cells: Array<{ x: number; y: number }> = [];
  matrix.data.forEach((row, y) => row.forEach((dark, x) => { if (dark) cells.push({ x, y }); }));
  return (
    <svg
      role="img"
      tabIndex={0}
      aria-label="QR code for your authenticator app"
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={cn("max-w-full rounded-md bg-white", AUTH_FOCUS_RING)}
    >
      <rect width={matrix.size} height={matrix.size} fill="#fff" />
      {cells.map(({ x, y }) => <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#000" />)}
    </svg>
  );
}
