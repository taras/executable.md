/**
 * The private expansion authority one installed structural form is expanded
 * under.
 *
 * Canonical execution builds this from what it captured before any installation
 * ran. A suite that drives `expandSegments` directly — to read the segments a
 * document produced, and to trap the boundaries a child region would cross —
 * needs the same object, admitted on exactly the terms a run admits it on.
 */

import type { Operation } from "effection";

import {
  admitStructuralDeclarations,
  structuralCatalog,
} from "../../src/execution-declarations.ts";
import type { ExecutionInstallation } from "../../src/execute.ts";
import type { ExpansionAuthority } from "../../src/components/import-authority.ts";
import { createExactSource } from "../../src/output/exact-source.ts";

/** Admit one installation's structural catalog and bind its implementation. */
export function* installedAuthority(
  ...installations: readonly ExecutionInstallation[]
): Operation<ExpansionAuthority> {
  const expanders = installations.map((installation) => installation.expand?.bind(installation));
  const admitted = yield* admitStructuralDeclarations(
    installations.map((installation, owner) => ({
      owner,
      declarations: installation.declarations ?? [],
      expands: installation.expand !== undefined,
      ...(installation.expand === undefined
        ? {}
        : { expand: installation.expand.bind(installation) }),
    })),
  );
  const catalog = structuralCatalog(admitted);
  return {
    ...(catalog === undefined ? {} : { structural: catalog }),
    expanders,
    exact: createExactSource(),
  };
}
