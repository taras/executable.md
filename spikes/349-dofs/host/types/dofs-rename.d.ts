// Facade counterpart of vendor/dofs/dist/fs/rename.d.ts; see dofs.d.ts.

import type { Database } from "./dofs.d.ts";

export declare function rename(
  db: Database,
  oldPath: string,
  newPath: string,
): void;
