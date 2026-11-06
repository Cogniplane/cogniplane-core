"use client";

import { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AdminSkillZipUploadTab(props: {
  zipFileName: string;
  busyKey: string | null;
  error?: string;
  onZipFileNameChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form onSubmit={props.onSubmit} className="flex flex-col gap-4 px-1 py-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-zip-file">ZIP file</Label>
        <Input
          id="skill-zip-file"
          name="skill-zip-file"
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => props.onZipFileNameChange(event.target.files?.[0]?.name ?? "")}
        />
      </div>
      {props.error ? <p role="alert" className="text-sm text-danger">{props.error}</p> : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {props.zipFileName ? (
          <span className="min-w-0 break-all text-xs text-on-surface-variant">{props.zipFileName}</span>
        ) : null}
        <Button
          type="submit"
          disabled={!props.zipFileName || props.busyKey !== null}
        >
          {props.busyKey === "skill-import-zip" ? "Importing..." : "Import ZIP"}
        </Button>
      </div>
    </form>
  );
}
