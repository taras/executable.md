/**
 * The part that owns the terminal, and knows nothing about what is on it.
 *
 * The host measures the viewport, produces frames, normalizes raw input, hands
 * a location to be composed, and decides which renderer draws. What it never
 * does is name anything the application is made of: there is no route segment,
 * no drawer kind, no component and no fixture transition in this file, and the
 * evidence reads it to check. A host that knew a drawer was a drawer would be
 * the application wearing the host's clothes, and every new screen would have
 * to be taught to it.
 *
 * **Equivalent activations are the same activation.** A key arrives as bytes
 * and a pointer arrives as a button on something, and both are normalized
 * *here*, before anything is dispatched. What reaches the tree is one value
 * with no trace of how it was produced — so a control cannot tell a click from
 * a keypress, and "the same semantic action" is not a property anything has to
 * maintain.
 *
 * A pointer names *what* it was on, and that survives normalization. The name
 * is an opaque node identity the host resolves against the live tree: a target
 * the tree no longer holds, or one that was never a place focus could be —
 * a container, something drawn but not made focusable, or nothing at all —
 * takes no focus and receives no input. A target that is focusable takes focus
 * first, and then the activation is dispatched exactly as a keypress there
 * would have been.
 */

import { until } from "effection";
import type { Operation, Result } from "effection";
import { current, focus } from "../repl-study/vendor/freedom/upstream/index.ts";
import type { Node, Root } from "../repl-study/vendor/freedom/upstream/index.ts";

import type { Description } from "./component.ts";
import type { FrameClock } from "./frames.ts";
import { press } from "./input.ts";
import type { Delivery, KeyPress } from "./input.ts";
import { compose, focusTargets, paint } from "./reconcile.ts";
import type { Renderer } from "./render.ts";
import type { Viewport } from "./screen.ts";

/** What a terminal actually delivers, before anything has interpreted it. */
export type RawInput =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | {
      readonly kind: "pointer";
      readonly button: "primary" | "secondary";
      /** Which node it was on, as an opaque identity the host does not read. */
      readonly on: string;
    };

/**
 * One activation: what happened, and what it happened on.
 *
 * The target survives normalization and the keypress does not carry it, so the
 * tree is handed the same value either way and a component cannot answer one
 * differently from the other.
 */
export interface Activation {
  readonly key: KeyPress;
  /** The node the raw input named, when it named one. */
  readonly on?: string;
}

/** The one normalized form. Nothing downstream can tell which raw input made it. */
export function normalize(raw: RawInput): Activation | undefined {
  if (raw.kind === "pointer") {
    return { key: raw.button === "primary" ? { key: "Enter" } : { key: "Escape" }, on: raw.on };
  }
  const [first, ...rest] = raw.bytes;
  if (first === 13 || first === 10) {
    return { key: { key: "Enter" } };
  }
  if (first === 27 && rest.length === 0) {
    return { key: { key: "Escape" } };
  }
  if (first === 9) {
    return { key: { key: "Tab" } };
  }
  return undefined;
}

/** The node one opaque identity names, searched in the tree that exists now. */
function held(root: Node, id: string): Node | undefined {
  if (root.id === id) {
    return root;
  }
  for (const child of root.children) {
    const found = held(child, id);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export interface Host {
  /** Show whatever these descriptions describe, mounting and removing as needed. */
  show(descriptions: readonly Description[]): Operation<Result<void>>;
  /** Advance the clock, completing once every branch has applied the frame. */
  advance(timestamp: number): Operation<void>;
  /** Deliver one raw input to whatever currently has focus. */
  deliver(raw: RawInput): Delivery;
  /** The bytes this viewport receives, drawn from the mounted tree. */
  draw(): string;
  /** Swap the renderer. Nothing about the mounted tree changes. */
  use(renderer: Renderer): void;
  /** Re-measure. Nothing about which components exist changes. */
  resize(viewport: Viewport): void;
  readonly viewport: Viewport;
  readonly renderer: Renderer;
}

export interface HostOptions {
  readonly root: Root;
  readonly clock: FrameClock;
  readonly renderer: Renderer;
  readonly viewport: Viewport;
}

export function createHost(options: HostOptions): Host {
  const { root, clock } = options;
  let renderer = options.renderer;
  let viewport = options.viewport;

  return {
    get viewport(): Viewport {
      return viewport;
    },
    get renderer(): Renderer {
      return renderer;
    },

    show: (descriptions: readonly Description[]) => compose(root.node, descriptions, clock),

    advance: (timestamp: number) => clock.advance(timestamp),

    deliver(raw: RawInput): Delivery {
      const nothing: Delivery = { target: "", path: [], action: undefined };
      const activation = normalize(raw);
      if (activation === undefined) {
        return nothing;
      }
      if (activation.on === undefined) {
        return press(root.node, current(root.node), activation.key);
      }
      const on = held(root.node, activation.on);
      if (on === undefined || !focusTargets(root.node).includes(on)) {
        // Removed, a container, drawn but never made focusable, or nothing at
        // all: none of those is a place input can go, so none of them takes
        // focus on the way to finding that out.
        return nothing;
      }
      focus(on);
      return press(root.node, on, activation.key);
    },

    draw(): string {
      return renderer.draw(paint(root.node), viewport.columns);
    },

    use(next: Renderer): void {
      renderer = next;
    },

    resize(next: Viewport): void {
      viewport = next;
    },
  };
}

/** Tear the mounted tree down, which is the only thing a host owns of it. */
export function* close(root: Root): Operation<void> {
  yield* until(root.destroy());
}

/** Whichever node has focus right now, derived from the tree. */
export function focused(root: Root): Node {
  return current(root.node);
}
