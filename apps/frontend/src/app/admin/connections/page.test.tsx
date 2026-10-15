// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Page from "./page";

let query = "connection=first";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(query) }));
vi.mock("../../../components/admin/mcp/admin-mcp-content", () => ({ AdminMcpContent: ({ targetServerId }: { targetServerId: string | null }) => <p>Connection {targetServerId}</p> }));
vi.mock("../integrations/page", () => ({ default: () => <p>Integrations</p> }));

afterEach(cleanup);

it("renders both connection lists and passes the connection link to the MCP list", () => {
  const page = render(<Page />);
  expect(screen.getByText("Connection first")).toBeTruthy();
  expect(screen.getByText("Integrations")).toBeTruthy();
  query = "connection=second";
  page.rerender(<Page />);
  expect(screen.getByText("Connection second")).toBeTruthy();
});
