/* What the studio sees of a run: pure shapes shared by the server that makes
   them and the client that draws them. */

export type ResultView = {
  id: string;
  index: number;
  status: "running" | "completed" | "failed";
  url: string | null;
  /** The team's own copy has landed; the url no longer expires. */
  mirrored: boolean;
  error?: string;
};

export type RunView = {
  /** The run id: what the studio watches. */
  requestId: string;
  status: "running" | "completed" | "failed";
  /** Past the model's deadline without an answer; still checked, less often. */
  stalled: boolean;
  error?: string;
  creditsConsumed?: number;
  results: ResultView[];
};

export type CreatedRun = {
  requestId: string;
  resultIds: string[];
};
