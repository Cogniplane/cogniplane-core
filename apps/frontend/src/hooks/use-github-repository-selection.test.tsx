// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listGithubRepositories: vi.fn(),
  updateGithubAllowedRepositories: vi.fn()
}));

vi.mock("../lib/settings-api", () => api);

import { ApiError } from "../lib/api-client";
import { queryKeys } from "../lib/query-keys";
import { GITHUB_ACCOUNT_CHANGED_MESSAGE, useGithubRepositorySelection } from "./use-github-connection";

function render(githubUserId: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const view = renderHook(({ id }: { id: string | null }) => useGithubRepositorySelection(id), {
    wrapper,
    initialProps: { id: githubUserId }
  });
  return { ...view, queryClient, switchAccount: (id: string | null) => view.rerender({ id }) };
}

beforeEach(() => {
  api.listGithubRepositories.mockResolvedValue({
    repositories: [{ fullName: "Acme/App", private: true, archived: false }],
    truncated: true
  });
  api.updateGithubAllowedRepositories.mockResolvedValue(["acme/app"]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("does not call GitHub while the member is not connected", async () => {
  const { result } = render(null);

  await act(async () => {});
  expect(api.listGithubRepositories).not.toHaveBeenCalled();
  expect(result.current.repositories).toEqual([]);
});

it("lists the repositories once the member is connected", async () => {
  const { result } = render("gh-A");

  await waitFor(() => expect(result.current.repositories).toHaveLength(1));
  expect(result.current.truncated).toBe(true);
  expect(result.current.loadError).toBeNull();
});

it("reports a failed listing with a message the member can read", async () => {
  api.listGithubRepositories.mockRejectedValue(new Error("The GitHub authorization expired. Connect GitHub again."));
  const { result } = render("gh-A");

  await waitFor(() => expect(result.current.loadError).toBe("The GitHub authorization expired. Connect GitHub again."));
});

it("keeps the listing of one GitHub account apart from another", async () => {
  api.listGithubRepositories.mockResolvedValueOnce({
    repositories: [{ fullName: "a-org/secret", private: true, archived: false }],
    truncated: false
  });
  api.listGithubRepositories.mockResolvedValueOnce({
    repositories: [{ fullName: "b-org/app", private: true, archived: false }],
    truncated: false
  });
  const { result, queryClient, switchAccount } = render("gh-A");
  await waitFor(() => expect(result.current.repositories.map((r) => r.fullName)).toEqual(["a-org/secret"]));

  switchAccount("gh-B");
  // The listing of account A does not show for B while B loads.
  expect(result.current.repositories).toEqual([]);
  await waitFor(() => expect(result.current.repositories.map((r) => r.fullName)).toEqual(["b-org/app"]));
  expect(queryClient.getQueryData(queryKeys.settings.githubRepositories("gh-A"))).toMatchObject({
    repositories: [{ fullName: "a-org/secret" }]
  });
  expect(api.listGithubRepositories).toHaveBeenCalledTimes(2);
});

it("saves the list and reloads the status, not the repository listing", async () => {
  const { result, queryClient } = render("gh-A");
  await waitFor(() => expect(result.current.repositories).toHaveLength(1));
  queryClient.setQueryData(queryKeys.settings.github(), { configured: true });
  const invalidated = vi.spyOn(queryClient, "invalidateQueries");

  act(() => result.current.save(["acme/app"]));

  await waitFor(() => expect(result.current.saved).toBe(true));
  expect(api.updateGithubAllowedRepositories).toHaveBeenCalledWith("gh-A", ["acme/app"]);
  expect(invalidated).toHaveBeenCalledWith({ queryKey: queryKeys.settings.github(), exact: true });
  expect(api.listGithubRepositories).toHaveBeenCalledOnce();
});

it("shows a failed save", async () => {
  api.updateGithubAllowedRepositories.mockRejectedValue(new Error("Each repository must use the form owner/name."));
  const { result } = render("gh-A");

  act(() => result.current.save(["bad"]));

  await waitFor(() => expect(result.current.saveError).toBe("Each repository must use the form owner/name."));
  expect(result.current.saved).toBe(false);
});

it("sends the account that the page showed, and does not call the server without one", async () => {
  const { result } = render(null);

  act(() => result.current.save(["acme/app"]));

  await act(async () => {});
  expect(api.updateGithubAllowedRepositories).not.toHaveBeenCalled();
});

it("does not report a save for one account as saved for another", async () => {
  const { result, switchAccount } = render("gh-A");
  act(() => result.current.save(["acme/app"]));
  await waitFor(() => expect(result.current.saved).toBe(true));

  switchAccount("gh-B");

  expect(result.current.saved).toBe(false);
});

it("explains a refused save for a changed account and loads the status again", async () => {
  api.updateGithubAllowedRepositories.mockRejectedValue(new ApiError({
    status: 409,
    code: "github_account_changed",
    method: "PUT",
    path: "/me/github-connection/repositories",
    message: "409: something technical"
  }));
  const { result, queryClient } = render("gh-A");
  await waitFor(() => expect(result.current.repositories).toHaveLength(1));
  const invalidated = vi.spyOn(queryClient, "invalidateQueries");

  act(() => result.current.save(["a-org/secret"]));

  await waitFor(() => expect(result.current.saveError).toBe(GITHUB_ACCOUNT_CHANGED_MESSAGE));
  expect(result.current.saved).toBe(false);
  expect(invalidated).toHaveBeenCalledWith({ queryKey: queryKeys.settings.github(), exact: true });
});
