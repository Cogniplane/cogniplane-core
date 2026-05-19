"use client";

import { useEffect, useRef, useState } from "react";
import type { Model } from "@cogniplane/shared-types";

export function ModelSelector(props: {
  model: string;
  models: Model[];
  disabled?: boolean;
  onChange: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const displayName = props.models.find((m) => m.id === props.model)?.displayName ?? props.model;

  return (
    <div className="model-selector" ref={ref}>
      <button
        type="button"
        className="model-selector-trigger"
        disabled={props.disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-selector-label">{displayName}</span>
        <svg className="model-selector-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        </svg>
      </button>

      {open && props.models.length > 0 && (
        <ul className="model-selector-popover" role="listbox" aria-label="Select model">
          {props.models.map((m) => (
            <li
              key={m.id}
              role="option"
              aria-selected={m.id === props.model}
              className={`model-selector-option${m.id === props.model ? " model-selector-option--selected" : ""}`}
              onClick={() => {
                props.onChange(m.id);
                setOpen(false);
              }}
            >
              <span className="model-selector-option-name">{m.displayName}</span>
              <span className="model-selector-option-desc">{m.description}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
