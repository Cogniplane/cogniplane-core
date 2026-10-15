// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { AdminSessionDetailResourceUsage } from "@cogniplane/shared-types";

import { PILL_BLUE, PILL_GRAY } from "../../../lib/ui-tokens";
import { AdminSessionResourcesCard } from "./admin-session-resources-card";

afterEach(cleanup);

/** The part of the card under one heading ("Skills" or "MCP servers"). */
const section = (label: string) => within(screen.getByText(label, { selector: "strong" }).closest("div")!.parentElement!);

const resource = (resourceId: string, name: string, invokedCount: number): AdminSessionDetailResourceUsage =>
  ({ resourceId, name, materialized: true, invokedCount });

it("counts used and available resources and marks the invoked ones", () => {
  render(<AdminSessionResourcesCard
    skills={[resource("pdf", "PDF tools", 3), resource("csv", "CSV tools", 0), resource("web", "Web search", 1)]}
    mcpServers={[]}
  />);

  expect(section("Skills").getByText("2 used")).toBeTruthy();
  expect(section("Skills").getByText("3 available")).toBeTruthy();
  expect(section("MCP servers").getByText("0 used")).toBeTruthy();
  expect(section("MCP servers").getByText("0 available")).toBeTruthy();

  const pdf = screen.getByText("PDF tools · 3");
  expect(pdf.className).toBe(PILL_BLUE);
  expect(pdf.getAttribute("title")).toBe("Invoked 3 times");
  expect(screen.getByText("Web search · 1").getAttribute("title")).toBe("Invoked 1 time");

  const csv = screen.getByText("CSV tools");
  expect(csv.className).toBe(PILL_GRAY);
  expect(csv.getAttribute("title")).toBe("Materialized but never invoked");
});

it("says when a session materialized no MCP servers or skills", () => {
  render(<AdminSessionResourcesCard skills={[]} mcpServers={[resource("notion", "Notion", 0)]} />);

  expect(screen.getByText("No skills materialized in this session.")).toBeTruthy();
  expect(screen.queryByText("No MCP servers materialized in this session.")).toBeNull();
  expect(section("Skills").getByText("0 used")).toBeTruthy();
  expect(section("Skills").getByText("0 available")).toBeTruthy();
  expect(section("MCP servers").getByText("0 used")).toBeTruthy();
  expect(section("MCP servers").getByText("1 available")).toBeTruthy();
});
