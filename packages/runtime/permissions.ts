/**
 * Permissions Api — whether the scope asking is allowed the operation it is
 * about to perform.
 *
 * Two members, one for the document filesystem and one for HTTP, and both
 * answer `true` until something says otherwise. A host that permits everything
 * installs nothing; a scope that permits less installs middleware:
 *
 * ```typescript
 * yield* Permissions.around({
 *   files: ([operation], next) => (operation === "write" ? false : next(operation)),
 * });
 * ```
 *
 * ## Where the answer is asked
 *
 * At the implementation that performs the operation, immediately before its
 * first I/O, and nowhere else. The provider is what knows which class of
 * operation it is about to carry out, so it is what asks — a check placed at a
 * caller would be a check some other caller reaches the same filesystem
 * without. One consequence worth stating: a request is authorized *after* the
 * contextual middleware that may transform it, so what is permitted is what
 * would actually be performed rather than what was first asked for.
 *
 * ## What composition means
 *
 * A restriction installs at the default `max` order and composes like any other
 * middleware: it returns `false` to refuse, and otherwise delegates the
 * unchanged arguments. Delegation is what makes restrictions intersect — the
 * answer is the whole chain's, so a scope nested inside a read-only region
 * cannot permit a write by answering `true`, because the enclosing refusal is
 * never asked to delegate. A sibling outside that region is unaffected, since
 * what a scope sees is the chain its own ancestors installed.
 *
 * Do not implement a restriction by returning `true` early. Doing so answers
 * for every enclosing scope as well, which is the one thing a restriction must
 * not be able to do.
 *
 * A decision is synchronous. There is nothing to wait for in reading a policy
 * the installing scope already holds, and the answer stands immediately before
 * an effect — so it is a plain `boolean`, not an operation, and a chain cannot
 * be interleaved with other work between the answer and the I/O it authorizes.
 *
 * ## What this is, and is not
 *
 * It mediates the semantic operations named below: document filesystem access
 * through `API.Files`, and HTTP through `API.Fetch`. It is not a sandbox. The
 * low-level host filesystem (`API.Fs`), subprocesses, Git host operations and
 * every other native reach are not mediated by implication, and nothing here
 * confines code that calls them directly.
 *
 * It is also not a capability: a `true` answer supplies nothing. It says only
 * that the scope asking is not forbidden, and the operation still needs a
 * provider that can perform it. A replacement provider that performs real I/O
 * authorizes its own operation for the same reason the host one does; one that
 * answers synthetically, performing no I/O, has nothing to authorize.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { FetchInit } from "./apis.ts";

export interface PermissionsApi {
  /**
   * Whether this request may be sent.
   *
   * Asked with the request as it would go out — after every transformation
   * `API.Fetch` middleware made to it — so a restriction reads the actual
   * destination, method and headers rather than the caller's first draft.
   */
  fetch(input: string, init?: FetchInit): boolean;
  /**
   * Whether this class of document filesystem operation may be performed.
   *
   * Which class a request belongs to is decided by what the caller asked for,
   * not by what the filesystem turns out to hold: ensuring a directory that
   * already exists and deleting a path that names nothing are both `write`,
   * because a scope that may not change the filesystem may not ask to.
   */
  files(operation: "read" | "write"): boolean;
}

/**
 * The permission Api.
 *
 * Both defaults permit. An uninstalled Permissions is the ordinary case — most
 * runs are a person asking their own tools to touch their own files — and the
 * boundary that matters is already the provider's: an absent `API.Files`
 * provider reaches no filesystem at all, whatever this answers.
 */
export const Permissions: Api<PermissionsApi> = createApi<PermissionsApi>(
  "executablemd.runtime.permissions",
  {
    fetch: () => true,
    files: () => true,
  },
);

/**
 * What a refused request fails with.
 *
 * One fixed sentence. A permission refusal is reported where the request was
 * made, and the request itself is what the refusing scope was keeping out of
 * the message: a URL carries credentials in its query, and headers carry
 * tokens. The scope that installed the restriction already knows what it
 * refused.
 */
export const FETCH_NOT_PERMITTED_MESSAGE = "The HTTP request is not permitted in this scope.";
