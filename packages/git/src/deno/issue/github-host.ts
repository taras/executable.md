/**
 * The issue transport this platform ships, installed without naming its source.
 *
 * `useGitHubIssues` knows the protocol and not the platform, so a host hands it
 * the concrete transport and the credential behind it. This is that host's half,
 * and it is a wrapper rather than an option on the public installer for one
 * reason: the shipped source is merged into a private object here, so it is
 * never assigned into a caller's own options and never reachable from one.
 *
 * A caller may still substitute its own `access`, `host` or `configuration`, as
 * it already could — a supplied host callback receives the endpoint and answers
 * with the caller's own source. With no override, only this module closes over
 * the shipped one. Nothing is returned at all.
 */

import type { Operation } from "effection";
import { useGitHubIssues } from "./github.ts";
import type { GitHubIssuesOptions } from "./github.ts";
import { denoGitHubSource } from "../composition/github-host.ts";

export function useDenoGitHubIssues(options: GitHubIssuesOptions = {}): Operation<void> {
  return useGitHubIssues({ host: denoGitHubSource, ...options });
}
