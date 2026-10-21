/**
 * A source import's existing journal coordinate, carried with private expansion
 * inputs. The public block context gains no attribution member; its private
 * carrier lets the eval terminal retain the reference it was handed.
 */
import type { DurablePosition } from "@executablemd/durable-streams";
import type { CodeBlockContext, Json, SourcePosition } from "./types.ts";
import { sourceDescription } from "./source-position.ts";

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

class OwnedCodeBlock implements CodeBlockContext {
  declare language: string;
  declare content: string;
  declare blockId: string;
  declare componentName?: string;
  declare routing?: CodeBlockContext["routing"];
  declare position?: Readonly<SourcePosition>;
  readonly #owner: DurablePosition;

  constructor(context: CodeBlockContext, owner: DurablePosition) {
    Object.assign(this, context);
    this.#owner = owner;
  }

  static owner(context: CodeBlockContext): DurablePosition | undefined {
    return #owner in context ? context.#owner : undefined;
  }
}

export function sourceOwnedCodeBlock(
  context: CodeBlockContext,
  owner: DurablePosition | undefined,
): CodeBlockContext {
  return owner === undefined ? context : new OwnedCodeBlock(context, owner);
}

export function codeBlockSourceOwner(context: CodeBlockContext): DurablePosition | undefined {
  return OwnedCodeBlock.owner(context);
}
