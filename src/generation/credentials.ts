export class MissingCredentialsError extends Error {
  constructor() {
    super("The team has no KIE API key yet");
    this.name = "MissingCredentialsError";
  }
}

export function parseCredentialInput(data: unknown): { apiKey: string } {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Enter an API key");
  }
  const record = data as { apiKey?: unknown; api_key?: unknown };
  const apiKey = record.apiKey ?? record.api_key;
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("Enter an API key");
  const key = apiKey.trim();
  if (/\s/.test(key) || key.length < 16) throw new Error("That does not look like a KIE API key");
  return { apiKey: key };
}
