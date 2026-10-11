/* A batch of files goes up a few at a time rather than all at once or one by
   one: three in flight keeps a laptop's uplink busy without the browser
   queueing thirty PUTs. No dependency — a counter over a shared cursor. */

export type UploadResult<T = { url: string; assetId: string }> = {
  file: File;
  url?: string;
  assetId?: string;
  error?: string;
  /** What the worker returned, for callers whose worker hands back more. */
  value?: T;
};

export const UPLOAD_CONCURRENCY = 3;

/** Runs `work` over every file with at most `concurrency` in flight. Results
    come back in the files' order whatever order they finished in, and one
    failure is one result with an `error` rather than a rejected batch.
    `onSettled` fires as each file finishes, in finishing order, so a caller
    can put a url to use before the slow one behind it is done. */
export async function uploadPool<T extends { url: string; assetId: string }>(
  files: readonly File[],
  work: (file: File) => Promise<T>,
  options: {
    concurrency?: number;
    onSettled?: (result: UploadResult<T>, index: number) => void;
  } = {},
): Promise<UploadResult<T>[]> {
  const limit = Math.max(1, options.concurrency ?? UPLOAD_CONCURRENCY);
  const results: UploadResult<T>[] = new Array(files.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < files.length) {
      const index = cursor++;
      const file = files[index]!;
      let result: UploadResult<T>;
      try {
        const value = await work(file);
        result = { file, url: value.url, assetId: value.assetId, value };
      } catch (caught) {
        result = { file, error: caught instanceof Error ? caught.message : String(caught) };
      }
      results[index] = result;
      options.onSettled?.(result, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, files.length) }, worker));
  return results;
}
