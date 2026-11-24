import { Buffer } from "node:buffer";
import { markdownBoundaryBase64 } from "../generated/markdown-boundary.ts";

function trackerExports(instance: WebAssembly.Instance) {
  const {
    memory,
    tracker_input,
    tracker_input_free,
    tracker_new,
    tracker_free,
    tracker_feed,
    tracker_fence_marker,
    tracker_header,
  } = instance.exports;
  if (
    !(memory instanceof WebAssembly.Memory) ||
    typeof tracker_input !== "function" ||
    typeof tracker_input_free !== "function" ||
    typeof tracker_new !== "function" ||
    typeof tracker_free !== "function" ||
    typeof tracker_feed !== "function" ||
    typeof tracker_fence_marker !== "function" ||
    typeof tracker_header !== "function"
  ) {
    throw new Error("Invalid Markdown tracker WASM exports");
  }
  return {
    memory,
    tracker_input,
    tracker_input_free,
    tracker_new,
    tracker_free,
    tracker_feed,
    tracker_fence_marker,
    tracker_header,
  };
}

export function trackerInput(instance: WebAssembly.Instance) {
  const library = trackerExports(instance);
  let capacity = 0;
  let pointer = 0;
  function copy(line: string): number {
    if (capacity < line.length) {
      if (capacity !== 0) {
        library.tracker_input_free(pointer, capacity);
      }
      capacity = Math.max(line.length, capacity * 2, 256);
      pointer = library.tracker_input(capacity);
    }
    if (line.length > 0) {
      const units = new Uint16Array(library.memory.buffer, pointer, line.length);
      for (let at = 0; at < line.length; at++) {
        units[at] = line.charCodeAt(at);
      }
    }
    return pointer;
  }
  return copy;
}

const instance = new WebAssembly.Instance(
  new WebAssembly.Module(Buffer.from(markdownBoundaryBase64, "base64")),
);
const library = trackerExports(instance);
const input = trackerInput(instance);

type Range = { readonly start: number; readonly end: number };

export function indentationEdits(
  source: string,
  blocks: readonly Range[],
  headers: readonly Range[],
): Uint32Array {
  if (blocks.length === 0) {
    return new Uint32Array();
  }
  const {
    formatter_buffer_new: allocate,
    formatter_buffer_data: data,
    formatter_buffer_length: length,
    formatter_buffer_free: free,
    formatter_plan: plan,
  } = instance.exports;
  if (
    typeof allocate !== "function" ||
    typeof data !== "function" ||
    typeof length !== "function" ||
    typeof free !== "function" ||
    typeof plan !== "function"
  ) {
    throw new Error("Invalid indentation formatter WASM exports");
  }
  const count = 1 + 2 * (blocks.length + headers.length);
  const text = library.tracker_input(source.length);
  try {
    const ranges = allocate(count);
    try {
      const units = new Uint16Array(library.memory.buffer, text, source.length);
      for (let at = 0; at < source.length; at++) {
        units[at] = source.charCodeAt(at);
      }
      const words = new Uint32Array(library.memory.buffer, data(ranges), count);
      words[0] = blocks.length;
      let at = 1;
      for (const list of [blocks, headers]) {
        for (const { start, end } of list) {
          words[at++] = start;
          words[at++] = end;
        }
      }
      plan(text, source.length, ranges);
      return new Uint32Array(library.memory.buffer, data(ranges), length(ranges)).slice();
    } finally {
      free(ranges);
    }
  } finally {
    library.tracker_input_free(text, source.length);
  }
}

const NO_HEADER = 0xffffffff;
function wasmTracker() {
  const state = library.tracker_new();
  let closed = false;
  return {
    feed(line: string, candidate = NO_HEADER, fenceMode = 1) {
      return library.tracker_feed(state, input(line), line.length, candidate, fenceMode);
    },
    fenceMarker() {
      return library.tracker_fence_marker(state);
    },
    header(accepted: boolean, blankRest: boolean, minimumColumn: number) {
      return library.tracker_header(state, Number(accepted), Number(blankRest), minimumColumn);
    },
    close() {
      if (!closed) {
        library.tracker_free(state);
        closed = true;
      }
    },
  };
}

function indentation(line: string, from: number): number {
  let columns = 0;
  for (let at = from; at < line.length; at++) {
    if (line[at] === " ") {
      columns++;
    } else if (line[at] === "\t") {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
  }
  return columns;
}

export function markdownStream(
  authored: string,
  prefix: string,
  readHeader: (text: string, start: number) => number | undefined,
  closingTag: string | undefined,
) {
  const tracker = wasmTracker();
  let covered = -1;
  let lastStart = -1;
  const empty = { code: false, opensAt: undefined, fenceClose: false, fenceExit: false };
  let facts: { code: boolean; opensAt?: number; fenceClose: boolean; fenceExit: boolean } = empty;
  let lastCandidate = -1;
  let accepted = false;
  const blank = /[ \t]*(?:\r?\n|$)/y;
  const blankRest = (end: number) => {
    blank.lastIndex = end;
    return blank.test(authored);
  };

  function streamStart(start: number) {
    return (start === 0 || authored[start - 1] === "\n") && authored.startsWith(prefix, start)
      ? start + prefix.length
      : start;
  }

  const stream = {
    line(start: number, cut?: number, fenceScope: "all" | "container" | "none" = "all") {
      if (start === lastStart) {
        return facts;
      }
      if (start < covered) {
        return empty;
      }
      const from = streamStart(start);
      const newline = authored.indexOf("\n", from);
      const to = cut ?? (newline === -1 ? authored.length : newline);
      const line = authored.slice(from, to);
      // Container markers and indentation cannot contain '<'. Rust checks
      // whether this scanner-provided candidate is actually at block content.
      const first = line.indexOf("<");
      let candidate = NO_HEADER;
      if (first !== -1) {
        const offset = from + first;
        const end =
          closingTag !== undefined && authored.startsWith(closingTag, offset)
            ? offset + closingTag.length
            : /[A-Z]/.test(authored[offset + 1] ?? "")
              ? readHeader(authored, offset)
              : undefined;
        if (end !== undefined && blankRest(end)) {
          candidate = first;
        }
      }
      const fenceMode = fenceScope === "all" ? 3 : fenceScope === "container" ? 4 : 0;
      const flags = tracker.feed(line, candidate, fenceMode);
      lastStart = start;
      facts = {
        code: (flags & 1) !== 0,
        opensAt: (flags & 16) !== 0 ? from + tracker.fenceMarker() : undefined,
        fenceClose: (flags & 64) !== 0,
        fenceExit: (flags & 128) !== 0,
      };
      accepted = (flags & 2) !== 0;
      lastCandidate = candidate === NO_HEADER ? -1 : from + candidate;
      covered = newline === -1 ? authored.length : newline + 1;
      return facts;
    },
    lines(start: number, end: number) {
      for (
        let next = authored.indexOf("\n", start) + 1;
        next > 0 && next < end;
        next = authored.indexOf("\n", next) + 1
      ) {
        stream.line(next);
      }
    },
    header(start: number, end: number): boolean {
      let minimum = NO_HEADER;
      for (
        let next = authored.indexOf("\n", start) + 1;
        next > 0 && next < end;
        next = authored.indexOf("\n", next) + 1
      ) {
        minimum = Math.min(minimum, indentation(authored, streamStart(next)));
      }
      const disposition = tracker.header(
        accepted && lastCandidate === start,
        blankRest(end),
        minimum,
      );
      if (disposition === 2) {
        stream.lines(start, end);
        return false;
      }
      if (disposition === 1) {
        const newline = authored.indexOf("\n", end);
        covered = Math.max(covered, newline === -1 ? authored.length : newline + 1);
      } else {
        stream.lines(start, end);
      }
      return true;
    },
    close: tracker.close,
  };
  return stream;
}
