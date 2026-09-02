import type { StorageProbeObject } from "./support/probe-object.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      STORAGE_PROBE: DurableObjectNamespace<StorageProbeObject>;
    }
  }
}
