/**
 * What one presented frame placed, for whoever is watching the screen.
 *
 * After a frame's bytes reach the terminal, the screen reports the facts that
 * frame committed: its size and profile, the key holding focus, each control's
 * key and cell rectangle, each region's rectangle and each window's extent. A
 * test reads them beside the cells the terminal shows, so it can find a
 * control by its key instead of by its label, and know which pane a row is in
 * without counting borders.
 *
 * The report is a copy and the default does nothing with it. It offers no way
 * to dispatch, focus or change the screen, and nothing the screen does depends
 * on whether anyone is listening: it is sent after the frame is acknowledged,
 * and an observer that suspended would only delay the next frame.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

import type { ReplBounds, ReplLayoutManifest, ReplProfile } from "./layout.ts";
import { flatten } from "./layout.ts";
import type { ReplAdmission, ReplWindow } from "./layout-admission.ts";
import type { ReplRendered } from "./renderer.ts";
import type { ReplTerminalSize } from "./terminal.ts";

/** One control the frame placed: a target a pointer press or focus can reach. */
export interface ReplPresentedControl {
  readonly key: string;
  readonly bounds: ReplBounds;
}

/** The facts one presented frame committed. */
export interface ReplPresentedFrame {
  readonly size: ReplTerminalSize;
  readonly profile: ReplProfile;
  /** The key of the control holding focus after this frame's reconcile. */
  readonly focused: string | undefined;
  /** In draw order, so a later control is drawn over an earlier one. */
  readonly controls: readonly ReplPresentedControl[];
  /** Every region, viewport and band row the frame placed, by its id. */
  readonly regions: ReadonlyMap<string, ReplBounds>;
  /** Each scrolling reading's window, by that reading's identity. */
  readonly windows: ReadonlyMap<string, ReplWindow>;
}

export interface ReplFrameWitnessApi {
  presented(frame: ReplPresentedFrame): Operation<void>;
}

export const ReplFrameWitness: Api<ReplFrameWitnessApi> = createApi<ReplFrameWitnessApi>(
  "ReplFrameWitness",
  {
    *presented(_frame: ReplPresentedFrame): Operation<void> {},
  },
);

/** Copy what one committed frame placed out of its manifest, admission and map. */
export function presentedFrame(
  committed: {
    readonly rendered: ReplRendered;
    readonly manifest: ReplLayoutManifest;
    readonly admission: ReplAdmission;
  },
  keyOf: (node: string) => string | undefined,
  focused: string | undefined,
): ReplPresentedFrame {
  const { rendered, manifest, admission } = committed;
  const controls: ReplPresentedControl[] = [];
  for (const target of rendered.map.targets) {
    const key = keyOf(target.node);
    if (key !== undefined) {
      controls.push(Object.freeze({ key, bounds: target.bounds }));
    }
  }
  const regions = new Map<string, ReplBounds>();
  for (const box of flatten(manifest.root)) {
    const bounds = box.key === undefined ? rendered.map.regionOf(box.id) : undefined;
    if (bounds !== undefined) {
      regions.set(box.id, bounds);
    }
  }
  return Object.freeze({
    size: rendered.size,
    profile: manifest.profile,
    focused,
    controls: Object.freeze(controls),
    regions,
    windows: new Map(admission.windows),
  });
}
