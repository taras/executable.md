// oxlint-disable require-yield
import type { Api, Operation, Result } from "effection";
import { createApi } from "effection/experimental";
import type { Node } from "./types.ts";
import { TreeContext } from "./state.ts";

export interface Dispatch {
  dispatch(event: unknown): Operation<Result<true>>;
  getNodeById(id: string): Operation<Node | undefined>;
}

export const DispatchApi: Api<Dispatch> = createApi<Dispatch>(
  "freedom:dispatch",
  {
    *dispatch(_event: unknown): Operation<Result<true>> {
      return { ok: false, error: new Error("unhandled") };
    },

    *getNodeById(id: string): Operation<Node | undefined> {
      const tree = yield* TreeContext.expect();
      return tree.nodes.get(id);
    },
  },
);
