/**
 * `XMLHttpRequest` exposes abort and listener removal to `action()` cleanup, so
 * leaving the page cancels in-flight calls. Transport failures return status 0
 * for the same retryable outcome path as other unrecognized statuses.
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
