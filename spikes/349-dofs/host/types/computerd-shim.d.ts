// Facade for the vendored shim's consumed surface; mirrors
// vendor/computerd-shim/dist/shim/shim.d.ts.

import type { VirtualFileSystem } from "./platformatic-vfs.d.ts";

export interface ShimMount {
  unmount(): Promise<void>;
  flush(): Promise<void>;
  reconcileNow(): Promise<void>;
}

export declare function mountShim(options: {
  vfs: VirtualFileSystem;
  mountPoint: string;
  pollIntervalMs?: number;
}): Promise<ShimMount>;
