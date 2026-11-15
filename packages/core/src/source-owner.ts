import type { DurablePosition } from "@executablemd/durable-streams";
import { createContext } from "effection";
import type { Operation } from "effection";
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

/**
 * The source description for `position`, attributed to the source owner in
 * effect where it is read.
 *
 * Read-only: the Context stays core's own, so a caller describing a durable
 * effect names the owner core recorded and cannot install another.
 */
export function* readSourceOwnerDescription(
  position: Readonly<SourcePosition> | undefined,
): Operation<Record<string, Json>> {
  return sourceOwnerDescription(position, yield* SourceOwner.get());
}
