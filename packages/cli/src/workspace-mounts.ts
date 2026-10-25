import { Err, Ok } from "effection";
import type { Result } from "effection";
import { posix } from "node:path";

export interface WorkspaceMount {
  readonly source: string;
  readonly target: string;
}
export type WorkspaceMountTable = readonly WorkspaceMount[];
export interface MountHostPath {
  resolve(...paths: string[]): string;
}

export function parseWorkspaceMounts(
  values: readonly string[],
  capturedCwd: string,
  hostPath: MountHostPath,
): Result<WorkspaceMountTable> {
  const pairs: WorkspaceMount[] = [];
  for (const value of values) {
    const colon = value.lastIndexOf(":");
    const source = value.slice(0, colon);
    const target = value.slice(colon + 1);
    if (
      colon < 1 ||
      !target.startsWith("/") ||
      target.startsWith("//") ||
      target.includes("\\") ||
      target.includes(":") ||
      value.includes("\0") ||
      target.split("/").includes("..")
    ) {
      return Err(
        new Error("--mount needs SOURCE:TARGET with an explicit absolute document TARGET."),
      );
    }
    const normalized = posix.normalize(target);
    if (normalized === "/") {
      return Err(new Error("--mount TARGET cannot be the document root /."));
    }
    const destination = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
    if (
      pairs.some(
        (pair) =>
          pair.target === destination ||
          pair.target.startsWith(destination + "/") ||
          destination.startsWith(pair.target + "/"),
      )
    ) {
      return Err(
        new Error(`--mount TARGET ${JSON.stringify(destination)} overlaps another TARGET.`),
      );
    }
    pairs.push(
      Object.freeze({ source: hostPath.resolve(capturedCwd, source), target: destination }),
    );
  }
  pairs.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  return Ok(Object.freeze(pairs));
}
