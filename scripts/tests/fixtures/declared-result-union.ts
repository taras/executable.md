export interface Route {
  host: string;
  port: number;
}

/** Neither the alias name nor the payload names are what makes it a result. */
export type Outcome<T> = { ok: true; parsed: T } | { ok: false; reason: string };

export type ParseResult = { ok: true; value: Route } | { ok: false; error: string };

export type Multiline =
  | { ok: true; value: Route }
  | { ok: false; error: Error; retryable: boolean };

export function readRoute(text: string): { ok: true; route: Route } | { ok: false; error: string } {
  const match = /^([^:]+):(\d+)$/.exec(text);
  if (!match) {
    return { ok: false, error: `malformed route: ${text}` };
  }
  return { ok: true, route: { host: match[1]!, port: Number(match[2]) } };
}

export interface Reader {
  read(text: string): { ok: true; value: Route } | { ok: false; error: string };
}
