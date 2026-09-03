/**
 * A concrete owner, so admission and acquisition can be exercised end to end.
 *
 * It supplies the two things `WorkflowOwnerObject` leaves abstract — a policy
 * and a `perform` — and nothing else. `perform` answers with the command it was
 * given rather than doing durable work: what these tests are about is who is
 * allowed to send one, not what each one means.
 */

import { run } from "effection";
import { acquisitionHolders } from "../../../src/cloudflare/acquisition.ts";
import { WorkflowOwnerObject } from "../../../src/cloudflare/owner.ts";
import type { AdmissionRequest, OwnerConfiguration } from "../../../src/cloudflare/owner.ts";
import type { AdmissionPolicy } from "../../../src/cloudflare/admission.ts";
import type { TokenVerification, VerificationKey } from "../../../src/cloudflare/token.ts";
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

/** The claims a correctly issued token carries for the policy above. */
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
  /**
   * The verification material this owner is configured with.
   *
   * Installed by a test before it connects, exactly as a deployment would
   * install a fetched JWKS. It is closure state on the object, never something
   * an admission request can name.
   */
  #keys: VerificationKey[] = [];
  #now = 1_800_000_000;

  configure(keys: VerificationKey[], now?: number): void {
    this.#keys = keys;
    if (now !== undefined) {
      this.#now = now;
    }
  }

  protected configuration(): OwnerConfiguration {
    const verification: TokenVerification = {
      keys: this.#keys,
      skewSeconds: 60,
      now: () => this.#now,
    };
    return { policy: POLICY, verification };
  }

  protected perform(_socket: WebSocket, _runId: string, command: RunnerCommand): unknown {
    return { performed: command.command };
  }

  /**
   * Admit one connection, answering what happened rather than raising.
   *
   * The server half of the pair is what the object admitted. Verification is
   * asynchronous, so this drives the admission operation through one Effection
   * scope — the runtime callback boundary this host adapts at.
   */
  async admitConnection(request: Partial<AdmissionRequest>): Promise<string> {
    const pair = new WebSocketPair();
    const server = pair[1];
    const presented: AdmissionRequest = {
      runId: "runId" in request ? request.runId : RUN_ID,
      release: "release" in request ? request.release : POLICY.release,
      token: "token" in request ? request.token : undefined,
    };
    try {
      await run(() => this.admit(presented, server));
      return "admitted";
    } catch (error) {
      return refusalOf(error);
    }
  }

  /** The correlation the live acquisition is partitioned by. */
  acquisitionId(): string {
    const held = acquisitionHolders(this.ctx)[0];
    return held === undefined ? "" : held.held.acquisitionId;
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
