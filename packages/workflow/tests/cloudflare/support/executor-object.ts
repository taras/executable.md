/**
 * A concrete owner, so admission and acquisition can be exercised end to end.
 *
 * It supplies the two things `WorkflowOwnerObject` leaves abstract — a policy
 * and a `perform` — and nothing else. `perform` answers with the command it was
 * given rather than doing durable work: what these tests are about is who is
 * allowed to send one, not what each one means.
 */

import { acquisitionHolders } from "../../../src/cloudflare/acquisition.ts";
import { WorkflowOwnerObject } from "../../../src/cloudflare/owner.ts";
import type { AdmissionRequest, OwnerConfiguration } from "../../../src/cloudflare/owner.ts";
import type { AdmissionPolicy } from "../../../src/cloudflare/admission.ts";
import type { RunnerCommand } from "../../../src/cloudflare/commands.ts";
import { refusalOf } from "../../../src/cloudflare/owner.ts";

/** The identities this owner is configured to admit. */
export const POLICY: AdmissionPolicy = {
  issuer: "https://token.actions.githubusercontent.com",
  audience: "https://factory.example",
  repositoryId: "123456",
  repositoryOwnerId: "654321",
  eventName: "repository_dispatch",
  workflowRef: "octo/repo/.github/workflows/factory.yml@refs/heads/main",
  workflowSha: "0f2c9a1b3d4e5f60718293a4b5c6d7e8f9012345",
  jobWorkflowRef: "octo/repo/.github/workflows/factory.yml@refs/heads/main",
  release: "factory-2026.09.02-abcdef",
};

/** Claims a verifier would have authenticated for the policy above. */
export const VALID_CLAIMS: Record<string, unknown> = {
  iss: POLICY.issuer,
  aud: POLICY.audience,
  repository_id: POLICY.repositoryId,
  repository_owner_id: POLICY.repositoryOwnerId,
  event_name: POLICY.eventName,
  workflow_ref: POLICY.workflowRef,
  workflow_sha: POLICY.workflowSha,
  job_workflow_ref: POLICY.jobWorkflowRef,
};

const RUN_ID = "5cktgrv2zyutngh7bbddr2tyg2b5a567cg725hu5e7u42orerxaa";

export class ExecutorObject extends WorkflowOwnerObject {
  #acquisitions = 0;

  protected configuration(): OwnerConfiguration {
    return { policy: POLICY };
  }

  protected perform(_socket: WebSocket, _runId: string, command: RunnerCommand): unknown {
    return { performed: command.command };
  }

  /**
   * Admit one connection, answering what happened rather than raising.
   *
   * The client half of the pair is kept so a later call can drive it; the
   * server half is what the object admitted.
   */
  admitConnection(request: Partial<AdmissionRequest>): string {
    const pair = new WebSocketPair();
    const server = pair[1];
    this.#acquisitions += 1;
    try {
      this.admit(
        {
          runId: "runId" in request ? request.runId : RUN_ID,
          release: "release" in request ? request.release : POLICY.release,
          claims: "claims" in request ? request.claims : VALID_CLAIMS,
        },
        server,
        `acquisition-${this.#acquisitions}`,
      );
      return "admitted";
    } catch (error) {
      return refusalOf(error);
    }
  }

  /** How many live connections currently hold this run's executor. */
  holders(): number {
    return acquisitionHolders(this.ctx).length;
  }

  /** Send one message as the connection admitted at `index` (1-based). */
  send(index: number, raw: string): unknown {
    const socket = this.ctx.getWebSockets("executor")[index - 1];
    if (socket === undefined) {
      return { id: "", outcome: "refused", refusal: "no-such-connection" };
    }
    return this.onRunnerMessage(socket, RUN_ID, raw);
  }

  /** Send as a socket this object never admitted. */
  sendAsStranger(raw: string): unknown {
    const pair = new WebSocketPair();
    return this.onRunnerMessage(pair[1], RUN_ID, raw);
  }

  /** Close the connection admitted at `index`, releasing its acquisition. */
  closeConnection(index: number): void {
    const socket = this.ctx.getWebSockets("executor")[index - 1];
    if (socket !== undefined) {
      socket.close(1000, "done");
      this.webSocketClose(socket);
    }
  }
}
