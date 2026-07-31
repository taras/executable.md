/**
 * The page's HTTP calls, as operations.
 *
 * `XMLHttpRequest` rather than `fetch` because nothing in this bundle may be a
 * promise: the page runs inside one Effection scope, and a promise is work that
 * scope cannot cancel. `action()` closes that gap — its executor returns a
 * cleanup function that Effection calls however the operation ends, so a halted
 * page removes its listeners and aborts the request in flight instead of leaving
 * a callback pointed at a torn-down page.
 *
 * A transport failure is reported as status 0 rather than thrown. The caller has
 * to tell a person what happened either way, and `outcomeFor` already treats an
 * unrecognized status as retryable — so there is one path through the outcome,
 * not two.
 */

import { action } from "effection";
import type { Operation } from "effection";

export interface HttpResult {
  /** The response status, or 0 when the request never completed. */
  status: number;
  body: string;
}

export function get(url: string): Operation<HttpResult> {
  return send("GET", url);
}

export function postJson(url: string, body: string): Operation<HttpResult> {
  return send("POST", url, body);
}

function send(method: string, url: string, body?: string): Operation<HttpResult> {
  return action<HttpResult>((resolve) => {
    const xhr = new XMLHttpRequest();

    const onLoad = (): void => resolve({ status: xhr.status, body: xhr.responseText });
    const onFailure = (): void => resolve({ status: 0, body: "" });

    xhr.addEventListener("load", onLoad);
    xhr.addEventListener("error", onFailure);
    xhr.addEventListener("timeout", onFailure);
    xhr.addEventListener("abort", onFailure);

    xhr.open(method, url, true);
    if (body === undefined) {
      xhr.send();
    } else {
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(body);
    }

    return () => {
      xhr.removeEventListener("load", onLoad);
      xhr.removeEventListener("error", onFailure);
      xhr.removeEventListener("timeout", onFailure);
      xhr.removeEventListener("abort", onFailure);
      xhr.abort();
    };
  });
}
