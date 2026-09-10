/**
 * One runner, for one run whose storage is somewhere else.
 *
 * The four things a host has to be able to do — move the run's lifecycle, read
 * it, deliver into it, and attach it to a document execution — over
 * one configured owner client. Everything underneath is already built and
 * proved: the provider-neutral executor lifecycle, the no-acquisition read and
 * delivery planes, and the runner's Workspace coordinator. What this adds is
 * the composition, and the one thing composition has to get right.
 *
 * That one thing is the handoff from the lifecycle to the attachment. A begin
 * transition hands back a storage handle; an attachment needs the Workspace
 * runtime for the *same* run, over the same connection. Matching a run id, a
 * root or an anchor would be enough for two clients on two owners to satisfy —
 * their records can be identical — so nothing here matches a field. The handle
 * says which link it was opened from, this runner remembers the links its own
 * acquisitions produced, and both answers have to be the same object.
 *
 * Native work stays here. Materialization, the invocation-owned temporary
 * trees and the containment-checked filesystem are the runner's own, and the
 * owner runs none of them.
 *
 * One seam is deliberately not installed. The remote run-storage provider
 * answers `create` and `lookup` over an executor link, and a link is an
 * acquisition — so installing it here would mean holding one run's executor
 * connection open for as long as the host lives, whether or not anything ever
 * executed. Creation and lookup happen where the acquisition already is: the
 * begin transition takes one, creates or finds the run inside it, and gives it
 * back when its scope ends.
 */

import type { Operation, Result } from "effection";
import type { DurableEffect, EffectDescription, Json } from "@executablemd/durable-streams";
import type { WorkflowExecutionTransitions } from "../lifecycle/execution.ts";
import type { WorkflowRunDatabase } from "../storage/api.ts";
import {
  remoteRunOrigin,
  type RemoteRunLink,
  type RemoteWorkspaceLink,
} from "../remote/database.ts";
import type { RemoteExecutorConnection } from "../remote/lifecycle-link.ts";
import type { RemoteDeliveryLink } from "../remote/answer-link.ts";
import type { RemoteReadPlane } from "../remote/read.ts";
import { installRemoteInputDelivery } from "../remote/delivery.ts";
import { useRemoteLifecycleReads } from "../remote/inspection.ts";
import {
  createRemoteWorkspaceEffect,
  useRemoteRun,
  useRemoteWorkspaceEffects,
  withRemoteWorkspaceEffects,
} from "../remote/workspace.ts";
import { useWorkspaceEffects, type WorkspaceMutation } from "../workspace/effects.ts";
import { withDocumentCapabilities } from "./workspace/host.ts";
import type { WorkflowWorkspaceOptions } from "./workspace/host.ts";
import { WorkflowRequestError } from "../storage/errors.ts";
import { installRemoteWorkflowLifecycle } from "./remote-host.ts";
import { createRemoteWorkspaceFilesystem } from "./remote-workspace-files.ts";
import { runnerFiles, useRunnerTrees } from "./remote-files.ts";

/** The owner this runner reaches, as a configured client supplies it. */
export interface RemoteRunnerOwner {
  /** The run this client is bound to. */
  readonly runId: string;
  /** Admit one executor connection for this run, owned by the calling scope. */
  admit(runId: string): Operation<Result<RemoteExecutorConnection | "already-running">>;
  /** The no-acquisition read plane for this run. */
  reads(runId: string): Operation<Result<RemoteReadPlane>>;
  /** The no-acquisition delivery plane for this run. */
  readonly delivery: RemoteDeliveryLink;
}

/** What a trusted host supplies to assemble one runner. */
export interface RemoteWorkflowRunnerOptions {
  /** The configured client for the one owner this runner works against. */
  readonly owner: RemoteRunnerOwner;
  /**
   * Where this runner assembles fork candidates.
   *
   * Runner-local scratch, and nothing durable: an absolute directory this
   * process may write, supplied explicitly rather than read from anywhere.
   */
  readonly scratchRoot: string;
  /**
   * What a live or partial attachment installs beyond the run's own Workspace.
   *
   * The host-owned inputs the optional capabilities need — the credential
   * helper, the Issue and pull-request configuration, and the Agent profile
   * installer — supplied explicitly by whoever assembled this runner. Nothing
   * here is read from a flag, an environment variable, a prop or a global, and
   * an absent member installs the capability's unconfigured behavior rather
   * than a different one.
   */
  readonly capabilities?: WorkflowWorkspaceOptions;
}

/** What a host installs for a run whose storage is somewhere else. */
export interface RemoteWorkflowRunner {
  /** Install the executor lifecycle for this owner; hand back its transitions. */
  useRunHost(): Operation<WorkflowExecutionTransitions>;
  /** Install status, list and history over the no-acquisition read plane. */
  useLifecycle(): Operation<void>;
  /** Install typed answer delivery over the no-acquisition delivery plane. */
  useDelivery(): Operation<void>;
  /** Attach this run's Workspace to one live or partial document execution. */
  attach<T>(database: WorkflowRunDatabase, operation: Operation<T>): Operation<T>;
}

/**
 * Assemble one runner for one owner.
 *
 * The scope that asks owns everything this installs: the acquisition it takes,
 * the temporary trees it materializes into, and the handles it opens all end
 * when that scope does.
 */
export function* useRemoteWorkflowRunner(
  options: RemoteWorkflowRunnerOptions,
): Operation<RemoteWorkflowRunner> {
  const { owner } = options;
  /**
   * The links this runner's own acquisitions produced.
   *
   * Keyed by the link object, so membership is identity. A link from another
   * client — or a value shaped like one — is not in here, and a handle opened
   * from it cannot be attached however closely its record matches.
   */
  const admitted = new WeakMap<RemoteRunLink, RemoteWorkspaceLink>();

  return {
    *useRunHost(): Operation<WorkflowExecutionTransitions> {
      const transitions = yield* installRemoteWorkflowLifecycle({
        root: options.scratchRoot,
        *admit(runId: string): Operation<Result<RemoteExecutorConnection | "already-running">> {
          const connection = yield* owner.admit(runId);
          if (connection.ok && connection.value !== "already-running") {
            admitted.set(connection.value.link, connection.value.link);
          }
          return connection;
        },
        source: (runId: string) => owner.reads(runId),
      });
      return transitions;
    },

    *useLifecycle(): Operation<void> {
      const plane = yield* owner.reads(owner.runId);
      if (!plane.ok) {
        throw plane.error;
      }
      yield* useRemoteLifecycleReads(plane.value);
    },

    *useDelivery(): Operation<void> {
      yield* installRemoteInputDelivery(owner.delivery);
    },

    *attach<T>(database: WorkflowRunDatabase, operation: Operation<T>): Operation<T> {
      const origin = remoteRunOrigin(database);
      const link = origin === undefined ? undefined : admitted.get(origin.link);
      if (link === undefined) {
        // Not a handle this runner's own lifecycle opened. Nothing about the
        // handle is quoted back: what is wrong is which handle it is, and a
        // diagnostic naming a run would name the wrong one.
        throw new WorkflowRequestError(
          "this workflow run storage was not opened by this remote host, and cannot be attached.",
        );
      }
      const host = runnerFiles();
      const trees = yield* useRunnerTrees();
      const run = yield* useRemoteRun({
        link,
        database,
        files: host,
        trees,
        createFilesystem: (at, authorize) => createRemoteWorkspaceFilesystem(at, authorize),
      });
      yield* useRemoteWorkspaceEffects(run);
      // The document's own capabilities, over this exact binding. Installed
      // together because either half alone is wrong: the rules without the
      // binding would reach whatever filesystem an entrypoint left in scope,
      // and the binding without the rules would be a coordinator nothing asks.
      yield* useWorkspaceEffects(database, {
        create<Value extends Json>(
          description: EffectDescription,
          mutate: WorkspaceMutation<Value>,
        ): DurableEffect<Value> {
          return createRemoteWorkspaceEffect(run, description, (filesystem, metadata) =>
            mutate(filesystem, metadata),
          );
        },
      });
      return yield* withRemoteWorkspaceEffects(
        run,
        withDocumentCapabilities(database, operation, options.capabilities ?? {}),
      );
    },
  };
}
