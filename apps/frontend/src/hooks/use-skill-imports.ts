"use client";

import { FormEvent, useRef, useState } from "react";
import type { SkillImportResponse, SkillMarketplaceEntry } from "@cogniplane/shared-types";

import { emptyInlineSkillDraft, type InlineSkillDraft } from "../components/admin/skills/admin-skill-inline-tab";
import { emptyGithubImportDraft, type GithubImportDraft } from "../components/admin/skills/admin-skill-card-utils";
import { useConfirmLeave } from "./use-confirm-leave";
import { toErrorMessage } from "../lib/error-utils";

export type ImportTab = "marketplace" | "github" | "zip" | "inline";

export function useSkillImports(input: {
  manifestUrl: string | null | undefined;
  busyKey?: string | null;
  onImportZip: (file: File) => Promise<SkillImportResponse>;
  onImportGithub: (input: { githubUrl: string; ref?: string; subdirectory?: string }) => Promise<SkillImportResponse>;
  onImportInline: (input: InlineSkillDraft) => Promise<SkillImportResponse>;
  onImportMarketplace?: (entry: SkillMarketplaceEntry) => Promise<SkillImportResponse>;
  onImported: (result: SkillImportResponse) => void;
  onSaveManifestUrl: (url: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ImportTab>("inline");
  const [githubDraft, setGithubDraft] = useState(emptyGithubImportDraft);
  const [zipFileName, setZipFileName] = useState("");
  const [inlineDraft, setInlineDraft] = useState(emptyInlineSkillDraft);
  const [manifestEdit, setManifestEdit] = useState<{ value: string; base: string | null | undefined } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ImportTab | "manifest", string>>>({});
  const pending = useRef(false);
  const versions = useRef({ github: 0, zip: 0, inline: 0, manifest: 0 });
  const manifestUrlDraft = manifestEdit?.value ?? input.manifestUrl ?? "";
  const dirty = Boolean(zipFileName || Object.values(githubDraft).some(Boolean) || Object.values(inlineDraft).some(Boolean)
    || manifestUrlDraft.trim() !== (input.manifestUrl ?? ""));
  useConfirmLeave(dirty || busyKey !== null);

  async function run<T>(key: string, kind: ImportTab | "manifest", action: () => Promise<T>, success: (result: T) => void) {
    if (pending.current || input.busyKey) return;
    pending.current = true;
    setBusyKey(key);
    setErrors(current => ({ ...current, [kind]: undefined }));
    try { success(await action()); }
    catch (error) { setErrors(current => ({ ...current, [kind]: toErrorMessage(error, "Could not save this draft. Try again.") })); }
    finally { pending.current = false; setBusyKey(null); }
  }

  return {
    busyKey,
    errors,
    panel: { open, toggle: () => setOpen(value => !value), tab, setTab },
    github: {
      draft: githubDraft,
      setDraft: (update: (current: GithubImportDraft) => GithubImportDraft) => { versions.current.github++; setGithubDraft(update); },
      submit: (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const version = versions.current.github;
        return run("skill-import-github", "github", () => input.onImportGithub({
          githubUrl: githubDraft.githubUrl, ref: githubDraft.ref || undefined, subdirectory: githubDraft.subdirectory || undefined
        }), result => {
          if (versions.current.github === version) setGithubDraft(emptyGithubImportDraft);
          input.onImported(result);
        });
      }
    },
    zip: {
      zipFileName,
      setZipFileName: (value: string) => { versions.current.zip++; setZipFileName(value); },
      submit: (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const fileInput = event.currentTarget.elements.namedItem("skill-zip-file");
        if (!(fileInput instanceof HTMLInputElement) || !fileInput.files?.[0]) return;
        const file = fileInput.files[0];
        const version = versions.current.zip;
        return run("skill-import-zip", "zip", () => input.onImportZip(file), result => {
          if (versions.current.zip === version && fileInput.files?.[0] === file) { setZipFileName(""); fileInput.value = ""; }
          input.onImported(result);
        });
      }
    },
    inline: {
      draft: inlineDraft,
      setDraft: (draft: InlineSkillDraft) => { versions.current.inline++; setInlineDraft(draft); },
      submit: (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const version = versions.current.inline;
        return run("skill-import-inline", "inline", () => input.onImportInline({
          skillId: inlineDraft.skillId.trim(), skillName: inlineDraft.skillName.trim(),
          description: inlineDraft.description.trim(), instructions: inlineDraft.instructions
        }), result => {
          if (versions.current.inline === version) setInlineDraft(emptyInlineSkillDraft);
          input.onImported(result);
        });
      }
    },
    marketplace: {
      manifestUrlDraft,
      changedSavedUrl: manifestEdit !== null && manifestEdit.base !== input.manifestUrl,
      setManifestUrlDraft: (value: string) => {
        versions.current.manifest++;
        setManifestEdit(current => value === (input.manifestUrl ?? "") ? null : { value, base: current ? current.base : input.manifestUrl });
      },
      saveManifestUrl: (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (input.manifestUrl === undefined) return;
        const version = versions.current.manifest;
        return run("skill-marketplace-manifest-url", "manifest", () => input.onSaveManifestUrl(manifestUrlDraft.trim() || null), () => {
          if (versions.current.manifest === version) setManifestEdit(null);
        });
      },
      clearManifestUrl: () => {
        if (input.manifestUrl === undefined) return;
        // Unsaved text stays. The user's own clear is not an outside change of the saved URL.
        return run("skill-marketplace-manifest-url", "manifest", () => input.onSaveManifestUrl(null), () => {
          setManifestEdit(current => current && { ...current, base: null });
        });
      },
      importEntry: (entry: SkillMarketplaceEntry) => run(`skill-import-marketplace-${entry.slug}`, "marketplace",
        () => { if (!input.onImportMarketplace) throw new Error("Marketplace import unavailable."); return input.onImportMarketplace(entry); }, input.onImported)
    }
  };
}
