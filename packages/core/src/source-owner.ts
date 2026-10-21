import type { DurablePosition } from "@executablemd/durable-streams";
import { createContext } from "effection";
import type { Json, SourcePosition } from "./types.ts";
import { sourceDescription } from "./source-position.ts";

/** Attribution follows modifier execution even when middleware copies block inputs. */
export const SourceOwner = createContext<DurablePosition | undefined>("executablemd.source-owner");

export function sourceOwnerDescription(
  position: Readonly<SourcePosition> | undefined,
  owner: DurablePosition | undefined,
): Record<string, Json> {
  return {
    ...sourceDescription(position),
    ...(position?.path === undefined || owner === undefined
      ? {}
      : { "executablemd.source-owner": { coroutineId: owner.coroutineId, index: owner.index } }),
  };
}
