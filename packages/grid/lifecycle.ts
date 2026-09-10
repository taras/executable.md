/**
 * Driving one provider through one grid's life
 * (architecture.md §Package ownership).
 *
 * The direct authority a host installs, the claims and readiness a grid passes
 * through before anything is shown, the row-major layout an author's `columns`
 * implies, the live and durable grid itself, what it retains, and the
 * reader-close boundary that ends it. A facet of `@executablemd/grid`: what
 * it shares with the root is the same object, not a copy.
 */

export {
  awaitReadiness,
  createGridRegistry,
  createGridAuthority,
  createGridClaims,
  sealOnTeardown,
  GridAuthorityError,
  gridInstallation,
  useGridInstallation,
} from "./src/authority.ts";
export type {
  GridRegistry,
  LiveGrid,
  PaneReadiness,
  GridAuthority,
  GridClaims,
  GridInstallation,
  PaneClaim,
} from "./src/authority.ts";

export { installGridProvider } from "./src/provider-api.ts";

export {
  createCloseBoundary,
  durableGrid,
  openGrid,
  paneNeverStartedMessage,
  retainedLayout,
  toRequest,
} from "./src/grid.ts";
export type {
  CloseBoundary,
  GridCloseKind,
  PaneStatus,
  PaneWork,
  RetainedGrid,
  RetainedPane,
  RetainedPaneOutcome,
} from "./src/grid.ts";

export { gridLayout } from "./src/layout.ts";
export type { PlacedPane, GridCell, GridLayout } from "./src/layout.ts";
