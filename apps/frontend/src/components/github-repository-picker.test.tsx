// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GithubRepositoryPicker, type GithubRepositoryPickerProps } from "./github-repository-picker";

afterEach(cleanup);

const listing = [
  { fullName: "Acme/App", private: true, archived: false },
  { fullName: "Acme/Docs", private: false, archived: true },
  { fullName: "octocat/Hello-World", private: false, archived: false }
];

function mount(overrides: Partial<GithubRepositoryPickerProps> = {}) {
  const onSave = vi.fn();
  const onReload = vi.fn();
  const props: GithubRepositoryPickerProps = {
    githubUserId: "gh-A",
    allowed: [],
    repositories: listing,
    truncated: false,
    isLoading: false,
    loadError: null,
    isSaving: false,
    saveError: null,
    saved: false,
    onReload,
    onSave,
    ...overrides
  };
  const view = render(<GithubRepositoryPicker {...props} />);
  return { onSave, onReload, props, rerender: (next: Partial<GithubRepositoryPickerProps>) =>
    view.rerender(<GithubRepositoryPicker {...props} {...next} />) };
}

const checkbox = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: /Save repositories|Saving/ }) as HTMLButtonElement;

describe("GithubRepositoryPicker", () => {
  it("says that the agent has no repository until the member selects one", () => {
    mount();

    expect(screen.getByText("none selected")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/cannot use GitHub yet/);
    expect(saveButton().disabled).toBe(true);
  });

  it("saves the selection in lower case, in a stable order", () => {
    const { onSave } = mount();

    fireEvent.click(checkbox("octocat/Hello-World"));
    fireEvent.click(checkbox("Acme/App"));
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    expect(onSave).toHaveBeenCalledWith(["acme/app", "octocat/hello-world"]);
  });

  it("shows the saved repositories as selected and can discard an edit", () => {
    mount({ allowed: ["acme/app"] });

    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.queryByText(/cannot use GitHub yet/)).toBeNull();
    expect(checkbox("Acme/App").checked).toBe(true);
    expect(checkbox("Acme/Docs").checked).toBe(false);

    fireEvent.click(checkbox("Acme/App"));
    expect(checkbox("Acme/App").checked).toBe(false);
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(checkbox("Acme/App").checked).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it("lets the member remove a saved repository that the listing does not show", () => {
    const { onSave } = mount({ allowed: ["acme/app", "gone/repo"] });

    fireEvent.click(checkbox("gone/repo"));
    fireEvent.click(saveButton());

    expect(onSave).toHaveBeenCalledWith(["acme/app"]);
  });

  it("filters the list by name without changing the selection", () => {
    const { onSave } = mount({ allowed: ["octocat/hello-world"] });

    fireEvent.change(screen.getByLabelText("Filter repositories"), { target: { value: "docs" } });
    const rows = within(screen.getByRole("list", { name: "Repositories" })).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Acme/Docs");
    expect(rows[0]!.textContent).toContain("archived");

    fireEvent.click(checkbox("Acme/Docs"));
    fireEvent.change(screen.getByLabelText("Filter repositories"), { target: { value: "no-such" } });
    expect(screen.getByText("No repository matches the filter.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter repositories"), { target: { value: "" } });
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith(["acme/docs", "octocat/hello-world"]);
  });

  it("adds a repository by name and rejects a value that is not owner/name", () => {
    const { onSave } = mount({ truncated: true });
    expect(screen.getByText(/Add any other repository by name/)).toBeTruthy();

    const input = screen.getByLabelText("Add a repository by name");
    for (const bad of ["app", "acme/app/extra", "acme/..", "acme/app?x=1"]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.click(screen.getByRole("button", { name: "Add by name" }));
      expect(screen.getByRole("alert").textContent, bad).toBe("Use the form owner/name.");
    }

    fireEvent.change(input, { target: { value: " Other/Private-Repo " } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add by name" }));
    expect((input as HTMLInputElement).value).toBe("");
    expect(checkbox("other/private-repo").checked).toBe(true);
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith(["other/private-repo"]);
  });

  it("stops adding at 200 repositories", () => {
    const many = Array.from({ length: 200 }, (_, i) => `acme/repo-${String(i).padStart(3, "0")}`);
    mount({ allowed: many, repositories: [] });

    expect(screen.getByText(/at most 200 repositories/)).toBeTruthy();
    expect((screen.getByLabelText("Add a repository by name") as HTMLInputElement).disabled).toBe(true);
    // A selected repository can still be removed.
    expect(checkbox("acme/repo-000").disabled).toBe(false);
  });

  it("shows the list and save failures, and blocks edits while it saves", () => {
    mount({ allowed: ["acme/app"], loadError: "Failed to load your GitHub repositories.", saveError: "Failed to save the repositories.", isSaving: true });

    const alerts = screen.getAllByRole("alert").map((node) => node.textContent);
    expect(alerts).toContain("Failed to load your GitHub repositories.");
    expect(alerts).toContain("Failed to save the repositories.");
    expect(checkbox("Acme/App").disabled).toBe(true);
    expect(saveButton().textContent).toBe("Saving...");
  });

  it("falls back to the saved list after a save changes it", () => {
    const { rerender } = mount({ allowed: [] });
    fireEvent.click(checkbox("Acme/App"));
    expect(checkbox("Acme/App").checked).toBe(true);

    rerender({ allowed: ["acme/app"], saved: true });

    expect(checkbox("Acme/App").checked).toBe(true);
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByText("Saved.")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it("drops a selection that was chosen for another GitHub account", () => {
    const { onSave, rerender } = mount({ githubUserId: "gh-A", allowed: [] });
    // The member prepares a selection for account A.
    fireEvent.click(checkbox("Acme/App"));
    expect(saveButton().disabled).toBe(false);

    // The status now shows account B, which starts with an empty list as well.
    rerender({ githubUserId: "gh-B", allowed: [] });

    expect(checkbox("Acme/App").checked).toBe(false);
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/account changed.*dropped your unsaved selection/);
    expect(onSave).not.toHaveBeenCalled();

    // A new choice belongs to account B and saves.
    fireEvent.click(checkbox("octocat/Hello-World"));
    expect(screen.queryByText(/dropped your unsaved selection/)).toBeNull();
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith(["octocat/hello-world"]);
  });

  it("asks GitHub again only when the member refreshes the list", () => {
    const { onReload } = mount();

    fireEvent.click(screen.getByRole("button", { name: "Refresh list" }));

    expect(onReload).toHaveBeenCalledOnce();
  });
});
