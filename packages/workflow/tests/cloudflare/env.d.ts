import type { ExecutorObject } from "./support/executor-object.ts";
import type { OwnerObject } from "./support/owner-object.ts";
import type { StorageProbeObject } from "./support/probe-object.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      STORAGE_PROBE: DurableObjectNamespace<StorageProbeObject>;
      OWNER: DurableObjectNamespace<OwnerObject>;
      EXECUTOR: DurableObjectNamespace<ExecutorObject>;
    }
  }
}
