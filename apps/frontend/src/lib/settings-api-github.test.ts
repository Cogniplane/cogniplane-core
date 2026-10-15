import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./api-client", () => api);

import { listGithubRepositories, updateGithubAllowedRepositories } from "./settings-api";

beforeEach(() => {
  api.request.mockReset();
});

describe("GitHub repository requests", () => {
  it("sends the account that the member chose the list for", async () => {
    api.request.mockResolvedValue({ allowedRepositories: ["acme/app"] });

    await expect(updateGithubAllowedRepositories("gh-A", ["Acme/App"])).resolves.toEqual(["acme/app"]);

    expect(api.request).toHaveBeenCalledWith("/me/github-connection/repositories", {
      method: "PUT",
      body: JSON.stringify({ githubUserId: "gh-A", repositories: ["Acme/App"] })
    });
  });

  it("refuses a response that does not match the contract", async () => {
    api.request.mockResolvedValue({ allowedRepositories: "acme/app" });

    await expect(updateGithubAllowedRepositories("gh-A", [])).rejects.toThrow();
  });

  it("parses the repository listing", async () => {
    api.request.mockResolvedValue({
      repositories: [{ fullName: "Acme/App", private: true, archived: false }],
      truncated: true
    });

    await expect(listGithubRepositories()).resolves.toEqual({
      repositories: [{ fullName: "Acme/App", private: true, archived: false }],
      truncated: true
    });
    expect(api.request).toHaveBeenCalledWith("/me/github-connection/repositories");
  });
});
