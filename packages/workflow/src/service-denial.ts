/** Workflow authority boundary for native service attachment. */

import type { Operation } from "effection";
import { API } from "@executablemd/runtime";

export class WorkflowServiceDeniedError extends Error {
  override name = "WorkflowServiceDeniedError";

  constructor() {
    super("workflow execution is not authorized to attach a native service");
  }
}

export function useWorkflowServiceDenial(): Operation<void> {
  return API.Service.around(
    {
      // deno-lint-ignore require-yield
      *start() {
        throw new WorkflowServiceDeniedError();
      },
    },
    { at: "min" },
  );
}
