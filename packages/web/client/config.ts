/**
 * The configuration the page fetches, validated before it is believed.
 *
 * The response comes from this WebForm's own server, but the page checks it
 * anyway: the value flows into the DOM, and "the server sent it" is not a shape.
 * A malformed or unexpected payload becomes a failure the page can report rather
 * than an `undefined` rendered into the body.
 *
 * `bodyHtml` was sanitized on the server by `renderBody`, and it is the only
 * field the page reads. Nothing widens that.
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
