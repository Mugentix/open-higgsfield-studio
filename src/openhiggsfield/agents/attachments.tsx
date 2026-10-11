"use client";

import { useId, useMemo, useState } from "react";

import type { AssetRecord } from "@/server/asset-actions";

import { useAssets } from "../asset-data";
import { AudioIcon, ChevronRightIcon, PlayBadgeIcon } from "../icons";

/* Files a run can take along: the team library the composer's asset picker
   reads — every upload any member sent, newest first — as a plain list to
   tick. The worker downloads what is ticked into the run's inputs/ folder
   under its own name, which is what the skills expect to find there. */

const KIND_WORDS: Record<AssetRecord["kind"], string> = { image: "Image", video: "Video", audio: "Audio" };

/** The list itself: a filter once it is long, a checkbox per file. */
export function AttachmentPicker({
  selected,
  onChange,
  label = "Attachments from the team library",
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  label?: string;
}) {
  const { assets, loading } = useAssets();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? assets.filter((asset) => asset.name.toLowerCase().includes(q)) : assets), [assets, q]);
  const picked = new Set(selected);

  const toggle = (id: string) => {
    onChange(picked.has(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);
  };

  if (!loading && assets.length === 0) {
    return <p className="ohf-attach-empty">Nothing in the team library yet — files uploaded in the composer land here.</p>;
  }

  return (
    <div className="ohf-attach-pick" role="group" aria-label={label}>
      {assets.length > 8 && (
        <input
          className="ohf-input ohf-attach-filter"
          placeholder="Filter files"
          aria-label="Filter files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <ul className="ohf-attach-list ohf-scroll">
        {shown.map((asset) => {
          const on = picked.has(asset.id);
          return (
            <li key={asset.id}>
              <label className="ohf-attach-row" data-on={on}>
                <input type="checkbox" checked={on} onChange={() => toggle(asset.id)} />
                <span className="ohf-attach-thumb" aria-hidden>
                  {asset.kind === "image" ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={asset.url} alt="" loading="lazy" />
                  ) : asset.kind === "video" ? (
                    <PlayBadgeIcon size={9} />
                  ) : (
                    <AudioIcon size={13} />
                  )}
                </span>
                <span className="ohf-attach-name" title={asset.name}>
                  {asset.name}
                </span>
                <span className="ohf-attach-kind">{KIND_WORDS[asset.kind]}</span>
              </label>
            </li>
          );
        })}
        {shown.length === 0 && q && <li className="ohf-attach-empty">No file matches “{query.trim()}”</li>}
      </ul>
    </div>
  );
}

/** The picker behind a disclosure that counts what is ticked, so a form
    stays short until files are wanted. */
export function AttachmentField({
  selected,
  onChange,
  disabled = false,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const count = selected.length;
  return (
    <div className="ohf-attach-field">
      <button
        type="button"
        className="ohf-attach-toggle"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="ohf-attach-chevron" aria-hidden>
          <ChevronRightIcon size={12} />
        </span>
        {count === 0 ? "Attach files from the library" : `${count} ${count === 1 ? "file" : "files"} attached`}
      </button>
      {open && (
        <div id={id}>
          <AttachmentPicker selected={selected} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
