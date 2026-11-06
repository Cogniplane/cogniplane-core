"use client";

import { standardUI } from "@copilotkit/react-core/v2/generative-ui";
import { useEffect, useRef, type ReactNode } from "react";

type ChartProps = {
  title?: string;
  chartType?: string;
  xKey?: string;
  data?: Array<Record<string, unknown>>;
  series?: Array<string | { key: string }>;
  yAxis?: { min?: number | string; max?: number | string };
};

/** Bar lengths need zero as their baseline unless the saved chart sets a bound. */
export function barAxis(props: ChartProps): ChartProps["yAxis"] {
  if ((props.chartType ?? "bar") !== "bar") return props.yAxis;
  const data = props.data ?? [];
  const keys = props.series?.length
    ? props.series.map(series => typeof series === "string" ? series : series.key)
    : Object.keys(data[0] ?? {}).filter(key => key !== props.xKey && typeof data[0][key] === "number");
  const values = data.flatMap(row => keys.map(key => row[key]))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return props.yAxis;
  return {
    ...props.yAxis,
    ...(props.yAxis?.min === undefined && values.every(value => value >= 0) ? { min: 0 } : {}),
    ...(props.yAxis?.max === undefined && values.every(value => value <= 0) ? { max: 0 } : {})
  };
}

const StandardChart = standardUI.components.get("Chart")!.component;
export function GenerativeChart(props: ChartProps) {
  if (!props.data?.length) return <figure className="m-0 min-w-0 text-sm">
    {props.title ? <figcaption className="mb-2 font-semibold">{props.title}</figcaption> : null}
    <p className="m-0 text-on-surface-variant">No chart data to show.</p>
  </figure>;
  return <StandardChart {...props} yAxis={barAxis(props)} />;
}

const StandardCarousel = standardUI.components.get("Carousel")!.component;
export function GenerativeCarousel(props: { children?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = root.current?.querySelector<HTMLElement>("[data-a2ui-carousel]");
    if (!scroller) return;
    // SDK 1.83 measures its arrows only on mount and scroll. A resize changes
    // the available slides too. Let its existing handler refresh both arrows
    // and the local active-index binding without remounting focused content.
    const observer = new ResizeObserver(() => scroller.dispatchEvent(new Event("scroll")));
    observer.observe(scroller);
    for (const slide of scroller.children) observer.observe(slide);
    return () => observer.disconnect();
  }, [props.children]);
  return <div ref={root} className="min-w-0 w-full"><StandardCarousel {...props} /></div>;
}
