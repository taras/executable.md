/**
 * Registers the composition components as ordinary defaults.
 *
 * Repository and Dir are ordinary registered defaults — not
 * reserved and not structural — so a repository-local component may shadow
 * one for its own scope, and the workflow host installs them only for a live
 * or partial attachment. A completed root replay does not attach any
 * provider, so a document that already ran through completion does not
 * re-register them either.
 */

import type { Operation } from "effection";
import { registerComponents } from "@executablemd/core";
import Repository, { props as repositoryProps } from "./components/Repository.ts";
import Dir, { props as dirProps } from "./components/Dir.ts";

const ORIGIN = "@executablemd/workflow/composition";

export function useCompositionComponents(): Operation<void> {
  return registerComponents([
    {
      name: "Repository",
      origin: ORIGIN,
      props: repositoryProps,
      fn: Repository,
    },
    {
      name: "Dir",
      origin: ORIGIN,
      props: dirProps,
      fn: Dir,
    },
  ]);
}
