"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { Surface } from "@/generation/catalog";

import { SURFACES, SURFACE_LABELS, type GalleryView } from "./data";
import { ImageIcon, VideoIcon } from "./icons";

const SURFACE_ICONS: Record<Surface, () => React.ReactNode> = {
  image: () => <ImageIcon />,
  video: () => <VideoIcon />,
};

/* The bar carries the two surfaces and the filters, nothing else: the team,
   the projects and the scopes that span both surfaces live in the sidebar. */
export function Topbar({
  view,
  onView,
  children,
}: {
  view: GalleryView;
  onView: (next: GalleryView) => void;
  /** The filter bar, beside the surfaces. */
  children?: ReactNode;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  /* The indicator is measured rather than derived from equal columns, so it
     morphs to each label's real width instead of padding the short one.
     Assets and Favorites are picked in the sidebar; while one of them is on
     screen no surface is selected and the plate fades out. */
  useEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return;
    let live = true;
    const measure = () => {
      if (!live) return;
      const active = tabs.querySelector<HTMLElement>('[aria-selected="true"]');
      setThumb(active ? { x: active.offsetLeft, w: active.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(tabs);
    // Inter swaps in after first paint and the labels resize under it.
    void document.fonts.ready.then(measure);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [view]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const from = SURFACES.indexOf(view as Surface);
      const to =
        event.key === "ArrowRight"
          ? (from + 1) % SURFACES.length
          : event.key === "ArrowLeft"
            ? (from - 1 + SURFACES.length) % SURFACES.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? SURFACES.length - 1
                : -1;
      if (to < 0) return;
      event.preventDefault();
      onView(SURFACES[to]!);
      tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
    },
    [onView, view],
  );

  return (
    <div className="ohf-topbar">
      <h1 className="ohf-sr">OpenHiggsfield AI — Open source AI studio</h1>

      <div className="ohf-bar ohf-enter-1">
        <div
          className="ohf-tabs"
          role="tablist"
          aria-label="Gallery scope"
          ref={tabsRef}
          onKeyDown={onKeyDown}
        >
          <span
            className="ohf-thumb"
            data-ready={thumb !== null}
            aria-hidden
            style={
              {
                "--thumb-x": `${thumb?.x ?? 0}px`,
                "--thumb-w": `${thumb?.w ?? 0}px`,
              } as React.CSSProperties
            }
          />
          {SURFACES.map((id) => {
            const selected = view === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                id={`ohf-tab-${id}`}
                aria-selected={selected}
                aria-controls="ohf-panel"
                /* With no surface selected the first tab is the way in. */
                tabIndex={selected || (!SURFACES.includes(view as Surface) && id === SURFACES[0]) ? 0 : -1}
                className="ohf-tab"
                data-view={id}
                onClick={() => onView(id)}
              >
                {SURFACE_ICONS[id]()}
                <span className="ohf-tab-label">{SURFACE_LABELS[id]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {children}
    </div>
  );
}
