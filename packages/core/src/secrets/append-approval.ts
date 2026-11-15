import type { DurableEvent } from "@executablemd/durable-streams";
import { ensure } from "effection";
import type { Operation } from "effection";
import { exactly, place, within } from "./secret-placement.ts";
import type { Path } from "./secret-placement.ts";
import type { SecretSpan } from "./scanner.ts";

export interface AppendApproval {
  readonly coroutineId: string;
  readonly type: string;
  readonly name: string;
  readonly fields: readonly {
    readonly path: Path;
    readonly text: string;
    readonly matches: readonly SecretSpan[];
  }[];
}

export interface AppendApprovals {
  /** Allow one matching append within the caller's scope. */
  approveAppend(approval: AppendApproval): Operation<void>;
}

export interface AppendGrant {
  claims(event: DurableEvent): boolean;
  admits(event: DurableEvent, serialized: string, spans: readonly SecretSpan[]): boolean;
  published?(event: DurableEvent): void;
}

export interface AppendApprovalOwner {
  approvals: AppendApprovals;
  grants: Set<AppendGrant>;
  registerGrant(grant: AppendGrant): Operation<void>;
}

export function* useAppendApprovalOwner(): Operation<AppendApprovalOwner> {
  const grants = new Set<AppendGrant>();
  let open = true;
  yield* ensure(() => {
    open = false;
    grants.clear();
  });

  function* registerGrant(grant: AppendGrant): Operation<void> {
    yield* ensure(() => {
      grants.delete(grant);
    });
    if (!open) {
      throw new Error("this execution's append approvals are closed");
    }
    grants.add(grant);
  }

  return {
    approvals: Object.freeze({
      approveAppend(approval: AppendApproval) {
        return registerGrant(approvedAppend(approval));
      },
    }),
    grants,
    registerGrant,
  };
}

function approvedAppend(approval: AppendApproval): AppendGrant {
  const { coroutineId, type, name } = approval;
  const fields = approval.fields.map(({ path, text, matches }) => ({
    path: [...path],
    text,
    matches: matches.map((match) => ({ ...match })),
  }));
  let used = false;
  function claims(event: DurableEvent): boolean {
    return (
      !used &&
      event.type === "yield" &&
      event.coroutineId === coroutineId &&
      event.description.type === type &&
      event.description.name === name
    );
  }
  return {
    claims,
    admits(event, serialized, spans) {
      if (!claims(event)) {
        return false;
      }
      used = true;
      const placed = place(
        serialized,
        fields.map(({ path }) => path),
      );
      return (
        placed !== undefined &&
        placed.every((field, index) => field.value === fields[index].text) &&
        spans.every((span) => {
          const at = within(placed, span);
          return at !== undefined && exactly(fields[at.leaf].matches, span, at.start, at.end);
        })
      );
    },
  };
}
