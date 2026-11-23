import { cwd } from "@executablemd/runtime";
import type { Operation } from "effection";
import { printErrors } from "../component-failures.ts";
import { writeFileText } from "../files.ts";
import type { FormDeclaration } from "../invocation-identity.ts";
import type { Json, Segment } from "../types.ts";
import { applyUnifiedDiff, fencedUnifiedDiff, UnifiedDiffError } from "../unified-diff.ts";
import { FileAccessError, readRequestedText, report } from "./File.ts";

const FENCE = "File.Patch requires exactly one passive fenced unified diff.";

export function* patchBody(
  props: Record<string, Json>,
  children: readonly Segment[] | undefined,
): Operation<string> {
  const requested = String(props.path);
  const source: string[] = [];
  for (const child of children ?? []) {
    if (child.type !== "text") {
      throw new FileAccessError(FENCE);
    }
    source.push(child.content);
  }
  const patch = fencedUnifiedDiff(source.join(""));
  if (patch === undefined) {
    throw new FileAccessError(FENCE);
  }

  const input = { cwd: yield* cwd(), path: requested };
  const before = yield* readRequestedText(input);
  let content: string;
  try {
    content = applyUnifiedDiff(before, patch, requested);
  } catch (error) {
    if (!(error instanceof UnifiedDiffError)) {
      throw error;
    }
    throw new FileAccessError(`cannot patch "${requested}": ${error.message}`);
  }
  const failure = yield* writeFileText({
    ...input,
    content,
    expectedContent: before,
  });
  if (failure !== undefined) {
    throw new FileAccessError(report(requested, failure));
  }
  return "";
}

export const form: FormDeclaration = {
  forms: "paired",
  fn: printErrors(() => {
    throw new FileAccessError(FENCE);
  }),
  refuse: () => new FileAccessError(FENCE),
};
