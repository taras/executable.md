/**
 * Validate configuration before it reaches the DOM. `bodyHtml` is the only field
 * consumed here and is sanitized on the server by `renderBody`.
 */

export interface FormConfig {
  bodyHtml: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function parseConfig(text: string): FormConfig {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new ConfigError("the form configuration is not JSON");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new ConfigError("the form configuration is not an object");
  }
  if (!("bodyHtml" in decoded)) {
    throw new ConfigError("the form configuration has no bodyHtml");
  }
  const { bodyHtml } = decoded;
  if (typeof bodyHtml !== "string") {
    throw new ConfigError("the form configuration's bodyHtml is not a string");
  }
  return { bodyHtml };
}
