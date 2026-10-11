/* Server actions answer with a value, never a throw: Next replaces a thrown
   message with a generic one in production, and the studio needs KIE's own
   words on a failed tile. */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: ActionErrorCode };

export type ActionErrorCode = "unauthenticated" | "no_team" | "forbidden" | "missing_key" | "invalid";

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function fail<T = never>(error: string, code?: ActionErrorCode): ActionResult<T> {
  return code ? { ok: false, error, code } : { ok: false, error };
}

/** Runs an action body and folds the errors the server raises on purpose into
    coded failures; anything else becomes a plain message. */
export async function guarded<T>(body: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return ok(await body());
  } catch (caught) {
    return fail(messageOf(caught), codeOf(caught));
  }
}

/** Names of the errors the server throws on purpose, whose words are meant
    for the person; a driver's or a library's message is not. */
const SPOKEN = new Set([
  "Error",
  "UnauthenticatedError",
  "NoTeamError",
  "ForbiddenError",
  "MissingCredentialsError",
  "PlaneError",
  "KieError",
]);

/** Drizzle wraps a failed statement in a plain Error whose message is the SQL
    and its params — the name says "Error", the words are the driver's. */
function isDriverError(caught: Error): boolean {
  return "query" in caught && typeof (caught as { query?: unknown }).query === "string";
}

export function messageOf(caught: unknown): string {
  if (caught instanceof Error) {
    if (SPOKEN.has(caught.name) && !isDriverError(caught)) return caught.message;
    console.error("[action]", caught);
    return "Something went wrong on the server; try again";
  }
  if (typeof caught === "string") return caught;
  return "Something went wrong";
}

function codeOf(caught: unknown): ActionErrorCode | undefined {
  const name = caught instanceof Error ? caught.name : "";
  if (name === "UnauthenticatedError") return "unauthenticated";
  if (name === "NoTeamError") return "no_team";
  if (name === "ForbiddenError") return "forbidden";
  if (name === "MissingCredentialsError") return "missing_key";
  if (name === "PlaneError") return "invalid";
  return undefined;
}

/** Client-side: an ok result's data, or a thrown Error carrying the message
    and code, so existing try/catch paths keep working. */
export class ActionError extends Error {
  readonly code: ActionErrorCode | undefined;
  constructor(error: string, code?: ActionErrorCode) {
    super(error);
    this.name = "ActionError";
    this.code = code;
  }
}

export function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) return result.data;
  throw new ActionError(result.error, result.code);
}
