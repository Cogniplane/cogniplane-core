import { useState } from "react";
import {
  GITHUB_ALLOWED_REPOSITORY_LIMIT,
  parseGithubRepositoryName,
  type GithubRepositoryOption
} from "@cogniplane/shared-types";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { HINT, LIST_ITEM, PILL_AMBER, PILL_BLUE, PILL_GRAY, SECTION_LABEL } from "../lib/ui-tokens";

export type GithubRepositoryPickerProps = {
  /** The connected GitHub account. A selection belongs to the account that it started from. */
  githubUserId: string;
  /** The saved list, lower case. Empty means that the agent can use no repository. */
  allowed: string[];
  repositories: GithubRepositoryOption[];
  truncated: boolean;
  isLoading: boolean;
  loadError: string | null;
  isSaving: boolean;
  saveError: string | null;
  saved: boolean;
  onReload: () => void;
  onSave: (repositories: string[]) => void;
};

const keyOf = (name: string) => name.toLowerCase();

export function GithubRepositoryPicker(input: GithubRepositoryPickerProps) {
  const { allowed, repositories, githubUserId } = input;
  const allowedKey = allowed.join("\n");
  // The edit belongs to the saved list and the GitHub account that it started
  // from. When a save changes the saved list, or a reconnect changes the
  // account, the edit no longer applies and the saved list shows.
  const [draft, setDraft] = useState<{ githubUserId: string; base: string; selected: string[] } | null>(null);
  const [filter, setFilter] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  const draftAccountChanged = draft !== null && draft.githubUserId !== githubUserId;
  const selected = draft && !draftAccountChanged && draft.base === allowedKey ? draft.selected : allowed;
  const selectedKeys = new Set(selected);
  const dirty = selected.length !== allowed.length || selected.some((name) => !allowed.includes(name));
  const atLimit = selected.length >= GITHUB_ALLOWED_REPOSITORY_LIMIT;

  const edit = (next: string[]) =>
    setDraft({ githubUserId, base: allowedKey, selected: [...new Set(next)].sort() });
  const toggle = (name: string, on: boolean) =>
    edit(on ? [...selected, keyOf(name)] : selected.filter((entry) => entry !== keyOf(name)));

  const listed = new Set(repositories.map((repository) => keyOf(repository.fullName)));
  // A selected repository that the listing does not show still needs a row,
  // or the member could not remove it.
  const rows: GithubRepositoryOption[] = [
    ...selected.filter((name) => !listed.has(name)).map((name) => ({ fullName: name, private: false, archived: false })),
    ...repositories
  ];
  const needle = filter.trim().toLowerCase();
  const visibleRows = needle ? rows.filter((row) => keyOf(row.fullName).includes(needle)) : rows;

  const addByName = () => {
    const name = manualName.trim();
    if (!parseGithubRepositoryName(name)) {
      setManualError("Use the form owner/name.");
      return;
    }
    setManualError(null);
    setManualName("");
    edit([...selected, keyOf(name)]);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={SECTION_LABEL}>Repository access</p>
            <h2 className="text-lg font-semibold text-on-surface">Repositories the agent can use</h2>
            <p className="mt-1 max-w-prose text-sm text-on-surface-variant">
              The agent works only in the repositories that you select here. It cannot change this
              list. Your GitHub account must also have access to each repository.
            </p>
          </div>
          <span className={allowed.length === 0 ? PILL_AMBER : PILL_BLUE}>
            {allowed.length === 0 ? "none selected" : `${allowed.length} selected`}
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {allowed.length === 0 ? (
          <p role="status" className="text-sm text-warning">
            The agent cannot use GitHub yet. Select the repositories it may use, then save.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Filter repositories"
            placeholder="Filter repositories"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="max-w-xs"
          />
          <Button type="button" variant="ghost" size="sm" disabled={input.isLoading} onClick={input.onReload}>
            {input.isLoading ? "Loading..." : "Refresh list"}
          </Button>
        </div>

        {input.loadError ? (
          <p role="alert" className="text-sm text-danger">{input.loadError}</p>
        ) : null}

        {visibleRows.length > 0 ? (
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto" aria-label="Repositories">
            {visibleRows.map((repository) => {
              const checked = selectedKeys.has(keyOf(repository.fullName));
              return (
                <li key={repository.fullName} className={`${LIST_ITEM} flex flex-wrap items-center justify-between gap-2`}>
                  <label className="flex min-w-0 items-center gap-2 text-sm text-on-surface">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={input.isSaving || (!checked && atLimit)}
                      onChange={(event) => toggle(repository.fullName, event.target.checked)}
                      className="size-4 rounded border-outline-variant accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <span className="min-w-0 truncate">{repository.fullName}</span>
                  </label>
                  <span className="flex items-center gap-1.5">
                    {repository.private ? <span className={PILL_GRAY}>private</span> : null}
                    {repository.archived ? <span className={PILL_GRAY}>archived</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : !input.isLoading && !input.loadError ? (
          <p className={HINT}>
            {needle ? "No repository matches the filter." : "GitHub lists no repository for your account."}
          </p>
        ) : null}

        {input.truncated ? (
          <p className={HINT}>
            The list shows the {repositories.length} most recently updated repositories. Add any
            other repository by name.
          </p>
        ) : null}

        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            addByName();
          }}
        >
          <div className="flex flex-col gap-1">
            <Input
              aria-label="Add a repository by name"
              placeholder="owner/name"
              value={manualName}
              onChange={(event) => {
                setManualName(event.target.value);
                setManualError(null);
              }}
              disabled={input.isSaving || atLimit}
              aria-invalid={manualError !== null}
              className="w-64"
            />
            {manualError ? <p role="alert" className="text-sm text-danger">{manualError}</p> : null}
          </div>
          <Button type="submit" variant="outline" size="sm" disabled={input.isSaving || atLimit || manualName.trim() === ""}>
            Add by name
          </Button>
        </form>

        {atLimit ? (
          <p className={HINT}>You can select at most {GITHUB_ALLOWED_REPOSITORY_LIMIT} repositories.</p>
        ) : null}
        {draftAccountChanged ? (
          <p role="alert" className="text-sm text-danger">
            The connected GitHub account changed, so the page dropped your unsaved selection.
            Choose the repositories again.
          </p>
        ) : null}
        {input.saveError ? (
          <p role="alert" className="text-sm text-danger">{input.saveError}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!dirty || input.isSaving} onClick={() => input.onSave(selected)}>
            {input.isSaving ? "Saving..." : "Save repositories"}
          </Button>
          {dirty ? (
            <Button type="button" variant="ghost" disabled={input.isSaving} onClick={() => setDraft(null)}>
              Discard changes
            </Button>
          ) : input.saved ? (
            <span role="status" className={HINT}>Saved.</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
