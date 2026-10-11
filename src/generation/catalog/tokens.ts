/** Shared allow-lists. Each value is KIE's own spelling; casing that KIE wants
    different on the wire is handled by the entry's `values` coercions. */

export const SEEDANCE_ASPECT = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"] as const;

export const VIDEO_ASPECT = ["16:9", "9:16", "1:1"] as const;

/** Ten minutes is generous for an image and tight for a long video. */
export const IMAGE_DEADLINE_MS = 10 * 60_000;
export const VIDEO_DEADLINE_MS = 20 * 60_000;
export const LONG_VIDEO_DEADLINE_MS = 30 * 60_000;
