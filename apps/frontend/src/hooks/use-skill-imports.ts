"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type { SkillImportResponse } from "@cogniplane/shared-types";

import {
  emptyInlineSkillDraft,
  type InlineSkillDraft
} from "../components/admin/skills/admin-skill-inline-tab";
import {
  emptyGithubImportDraft,
  type GithubImportDraft
} from "../components/admin/skills/admin-skill-card-utils";

export type ImportTab = "marketplace" | "github" | "zip" | "inline";

export type ImportPanelState = {
  open: boolean;
  toggle: () => void;
  tab: ImportTab;
  setTab: (tab: ImportTab) => void;
};

export type GithubImportTabState = {
  draft: GithubImportDraft;
  setDraft: (updater: (current: GithubImportDraft) => GithubImportDraft) => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
};

export type ZipImportTabState = {
  zipFileName: string;
  setZipFileName: (value: string) => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
};

export type InlineImportTabState = {
  draft: InlineSkillDraft;
  setDraft: (draft: InlineSkillDraft) => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
};

export type MarketplaceTabState = {
  manifestUrlDraft: string;
  setManifestUrlDraft: (value: string) => void;
  saveManifestUrl: (event: FormEvent<HTMLFormElement>) => void;
  clearManifestUrl: () => void;
};

export function useSkillImports(input: {
  manifestUrl: string | null;
  onImportZip: (file: File) => Promise<SkillImportResponse>;
  onImportGithub: (input: {
    githubUrl: string;
    ref?: string;
    subdirectory?: string;
  }) => Promise<SkillImportResponse>;
  onImportInline: (input: {
    skillId: string;
    skillName: string;
    description: string;
    instructions: string;
  }) => Promise<SkillImportResponse>;
  onImported: (result: SkillImportResponse) => void;
  onSaveManifestUrl: (url: string | null) => Promise<void>;
}): {
  panel: ImportPanelState;
  github: GithubImportTabState;
  zip: ZipImportTabState;
  inline: InlineImportTabState;
  marketplace: MarketplaceTabState;
} {
  const { manifestUrl, onImportZip, onImportGithub, onImportInline, onImported, onSaveManifestUrl } = input;

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ImportTab>("inline");
  const [githubDraft, setGithubDraft] = useState<GithubImportDraft>(emptyGithubImportDraft);
  const [zipFileName, setZipFileName] = useState<string>("");
  const [inlineDraft, setInlineDraft] = useState<InlineSkillDraft>(emptyInlineSkillDraft);
  const [manifestUrlDraft, setManifestUrlDraft] = useState<string>(manifestUrl ?? "");

  useEffect(() => {
    // Resync draft when the persisted manifest URL changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setManifestUrlDraft(manifestUrl ?? "");
  }, [manifestUrl]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const submitZip = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const fileInput = form.elements.namedItem("skill-zip-file");
      if (!(fileInput instanceof HTMLInputElement) || !fileInput.files?.[0]) return;
      try {
        const imported = await onImportZip(fileInput.files[0]);
        setZipFileName("");
        form.reset();
        setOpen(false);
        onImported(imported);
      } catch {
        return;
      }
    },
    [onImportZip, onImported]
  );

  const submitGithub = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      try {
        const imported = await onImportGithub({
          githubUrl: githubDraft.githubUrl,
          ref: githubDraft.ref || undefined,
          subdirectory: githubDraft.subdirectory || undefined
        });
        setGithubDraft(emptyGithubImportDraft);
        setOpen(false);
        onImported(imported);
      } catch {
        return;
      }
    },
    [githubDraft, onImportGithub, onImported]
  );

  const submitInline = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      try {
        const imported = await onImportInline({
          skillId: inlineDraft.skillId.trim(),
          skillName: inlineDraft.skillName.trim(),
          description: inlineDraft.description.trim(),
          instructions: inlineDraft.instructions
        });
        setInlineDraft(emptyInlineSkillDraft);
        setOpen(false);
        onImported(imported);
      } catch {
        return;
      }
    },
    [inlineDraft, onImportInline, onImported]
  );

  const saveManifestUrl = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = manifestUrlDraft.trim();
      try {
        await onSaveManifestUrl(trimmed === "" ? null : trimmed);
      } catch {
        return;
      }
    },
    [manifestUrlDraft, onSaveManifestUrl]
  );

  const clearManifestUrl = useCallback(async () => {
    try {
      await onSaveManifestUrl(null);
    } catch {
      return;
    }
  }, [onSaveManifestUrl]);

  return {
    panel: { open, toggle, tab, setTab },
    github: { draft: githubDraft, setDraft: setGithubDraft, submit: submitGithub },
    zip: { zipFileName, setZipFileName, submit: submitZip },
    inline: { draft: inlineDraft, setDraft: setInlineDraft, submit: submitInline },
    marketplace: { manifestUrlDraft, setManifestUrlDraft, saveManifestUrl, clearManifestUrl }
  };
}
