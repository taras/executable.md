/**
 * Observes one Delivery overlap child: what each reservation command settled
 * to, what the journal bound for it, which review sites ran and what call log
 * the fixture Role wrote. It changes no input, outcome or exception.
 *
 * The report holds only bounded labels, counts, codes and small integer
 * positions. Targets leave the process as digest labels, never as paths.
 */
import { Execution, Plugin } from "@executablemd/core/api";
import {
  type DurableEvent,
  type DurableStream,
  preserveJournalProvenance,
} from "@executablemd/durable-streams";
import { API, env } from "@executablemd/runtime";
import { writeTextFile } from "@effectionx/fs";
import { ensure, type Operation, until } from "effection";
import process from "node:process";

const LIMIT = 4;
const POSITIONS = 8;
const COUNT = 99;
const SOURCE = "executablemd.source-position";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Code = number | "absent" | "thrown" | "unsettled" | "unobserved";
type Canonical = number | "invalid" | "err" | "cancelled" | "none";

interface Reservation {
  kind: "primary" | "replacement" | "unknown";
  site: "primary" | "replacement" | "other" | "none";
  content: string;
  target: string | undefined;
  process: Code;
  canonical: Canonical;
}

interface Write {
  prior: number[] | "invalid" | "overflow";
  position: number | null;
  settled: "ok" | "err" | "thrown" | "unsettled";
}

interface Anchor {
  site: string;
  name: string;
  expected: number;
  test(line: string): boolean;
}

const ROOT: Anchor[] = [
  {
    site: "actionRefusal",
    name: "Fail",
    expected: 1,
    test: (line) => line.includes("<Fail") && line.includes("do not start another review"),
  },
  {
    site: "reviewEntered",
    name: "Delivery.Review",
    expected: 1,
    test: (line) => line.startsWith("<Delivery.Review "),
  },
];

const REVIEW: Anchor[] = [
  {
    site: "attempts",
    name: "Delivery.Attempts",
    expected: 3,
    test: (line) => line.startsWith("<Delivery.Attempts "),
  },
  {
    site: "primaryReservation",
    name: "exec",
    expected: 1,
    test: (line) => line.startsWith('```bash exec as="reserved"'),
  },
  {
    site: "attemptRefusal",
    name: "Fail",
    expected: 2,
    test: (line) => line.includes("<Fail") && line.includes("The review attempt already exists"),
  },
  {
    site: "primaryDispatch",
    name: "Delivery.Dispatch",
    expected: 1,
    test: (line) => line.startsWith("<Delivery.Dispatch ") && line.includes("position={0}"),
  },
  {
    site: "replacementReservation",
    name: "exec",
    expected: 1,
    test: (line) => line.startsWith('```bash exec as="replacementReserved"'),
  },
  {
    site: "replacementRefusal",
    name: "Fail",
    expected: 1,
    test: (line) =>
      line.includes("<Fail") && line.includes("The replacement review is already reserved"),
  },
  {
    site: "replacementDispatch",
    name: "Delivery.Dispatch",
    expected: 1,
    test: (line) => line.startsWith("<Delivery.Dispatch ") && line.includes("position={1}"),
  },
];

const DISPATCH: Anchor[] = [
  {
    site: "role",
    name: "Delivery.Role",
    expected: 1,
    test: (line) => line.startsWith("<Delivery.Role "),
  },
];

const RESERVATION = /^mkdir -- '((?:[^']|'"'"')*)'\s*$/;

function object(value: Json | undefined): { [key: string]: Json } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function text(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function decode(content: string, cwd: string | undefined): string | undefined {
  const match = RESERVATION.exec(content);
  if (match === null) {
    return undefined;
  }
  const target = match[1].replaceAll(`'"'"'`, "'");
  if (target.startsWith("/")) {
    return target;
  }
  return cwd === undefined ? undefined : cwd + "/" + target;
}

function kind(target: string | undefined): Reservation["kind"] {
  if (target === undefined) {
    return "unknown";
  }
  return target.endsWith("/replacement") ? "replacement" : "primary";
}

function digest(target: string): Operation<string> {
  return {
    *[Symbol.iterator]() {
      const bytes = yield* until(crypto.subtle.digest("SHA-256", new TextEncoder().encode(target)));
      return [...new Uint8Array(bytes)]
        .slice(0, 4)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
  };
}

function positions(content: string): Pick<Write, "prior" | "position"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { prior: "invalid", position: null };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { prior: "invalid", position: null };
  }
  const values: number[] = [];
  for (const call of parsed) {
    const position: unknown =
      typeof call === "object" && call !== null ? Reflect.get(call, "position") : undefined;
    if (typeof position !== "number" || !Number.isSafeInteger(position)) {
      return { prior: "invalid", position: null };
    }
    values.push(position);
  }
  const prior = values.slice(0, -1);
  return {
    prior: prior.length > POSITIONS ? "overflow" : prior,
    position: values[values.length - 1],
  };
}

class Observation {
  readonly sites: Record<string, number> = {};
  readonly anchors: string[] = [];
  readonly reservations: Reservation[] = [];
  readonly writes: Write[] = [];
  readonly sources = new Map<string, Map<number, string>>();
  review: string | undefined;
  readonly dropped = { reservations: 0, writes: 0, anchors: 0 };
  executions = 0;
  roles = { fixture: 0, production: 0, other: 0 };
  unattributed = 0;
  calledElsewhere = 0;

  count(site: string): void {
    this.sites[site] = Math.min(COUNT, (this.sites[site] ?? 0) + 1);
  }

  fault(label: string): void {
    if (this.anchors.length < LIMIT) {
      this.anchors.push(label);
    } else {
      this.dropped.anchors += 1;
    }
  }

  retain(document: string, path: string, content: string, anchors: Anchor[]): void {
    if (this.sources.has(path)) {
      return;
    }
    const lines = content.split("\n");
    const sites = new Map<number, string>();
    for (const anchor of anchors) {
      const found = lines.flatMap((line, index) => (anchor.test(line) ? [index + 1] : []));
      if (found.length !== anchor.expected) {
        this.fault(document + ":" + anchor.site + ":" + found.length);
      }
      found.forEach((line, index) => {
        sites.set(
          line,
          anchor.name + "|" + anchor.site + (anchor.expected > 1 ? String(index + 1) : ""),
        );
      });
    }
    this.sources.set(path, sites);
  }

  reservation(entry: Reservation): Reservation {
    if (this.reservations.length < LIMIT) {
      this.reservations.push(entry);
    } else {
      this.dropped.reservations += 1;
    }
    return entry;
  }

  write(entry: Write): Write {
    if (this.writes.length < LIMIT) {
      this.writes.push(entry);
    } else {
      this.dropped.writes += 1;
    }
    return entry;
  }

  site(position: Json | undefined, name: string): string | undefined {
    const source = object(position);
    const path = text(source?.path);
    const line = source?.line;
    if (path === undefined || typeof line !== "number") {
      return undefined;
    }
    const sites = this.sources.get(path);
    if (sites === undefined) {
      return undefined;
    }
    const site = sites.get(line);
    if (site === undefined || !site.startsWith(name + "|")) {
      if (
        path === this.review &&
        ["exec", "Fail", "Delivery.Dispatch", "Delivery.Attempts"].includes(name)
      ) {
        this.unattributed = Math.min(COUNT, this.unattributed + 1);
      }
      return undefined;
    }
    return site.slice(name.length + 1);
  }

  inspect(event: DurableEvent): void {
    if (event.type !== "yield") {
      return;
    }
    const { description, result } = event;
    const position = description[SOURCE];
    if (description.type === "import_component") {
      const value = result.status === "ok" ? object(result.value) : undefined;
      const path = text(value?.path);
      const content = text(value?.content);
      if (description.name === "__root__" && path !== undefined && content !== undefined) {
        this.retain("root", path, content, ROOT);
        return;
      }
      const site = this.site(position, description.name);
      if (site !== undefined) {
        this.count(site);
      }
      if (description.name === "Delivery.Review" && path !== undefined && content !== undefined) {
        this.review ??= path;
        this.retain("review", path, content, REVIEW);
      }
      if (description.name === "Delivery.Dispatch" && path !== undefined && content !== undefined) {
        this.retain("dispatch", path, content, DISPATCH);
      }
      if (site === "role") {
        const origin =
          path === undefined
            ? "other"
            : path.endsWith("tests/components/Delivery/Role.md")
              ? "fixture"
              : path.endsWith("components/Delivery/Role.md")
                ? "production"
                : "other";
        this.roles[origin] = Math.min(COUNT, this.roles[origin] + 1);
      }
      return;
    }
    if (description.type !== "exec") {
      return;
    }
    const command = description.command;
    const content = Array.isArray(command) ? text(command[2]) : undefined;
    const site = this.site(position, "exec");
    const reserved =
      site === "primaryReservation"
        ? "primary"
        : site === "replacementReservation"
          ? "replacement"
          : undefined;
    if (content === undefined || (reserved === undefined && !content.startsWith("mkdir -- "))) {
      return;
    }
    let canonical: Canonical = "cancelled";
    if (result.status === "ok") {
      const code = object(result.value)?.exitCode;
      canonical = typeof code === "number" && Number.isSafeInteger(code) ? code : "invalid";
    } else if (result.status === "err") {
      canonical = "err";
    }
    const entry =
      this.reservations.find((item) => item.content === content && item.canonical === "none") ??
      this.reservation({
        kind: kind(decode(content, undefined)),
        site: "none",
        content,
        target: decode(content, undefined),
        process: "unobserved",
        canonical: "none",
      });
    entry.site = reserved ?? "other";
    entry.canonical = canonical;
  }

  *report(slot: string, expected: string): Operation<string> {
    const labels = new Map<string, string>();
    const reservations: Array<
      Omit<Reservation, "content" | "target"> & { target: string; lexical: string }
    > = [];
    for (const entry of this.reservations) {
      let target = "unknown";
      let equality = "unknown";
      if (entry.target !== undefined) {
        target = labels.get(entry.target) ?? (yield* digest(entry.target));
        labels.set(entry.target, target);
        const wanted =
          entry.kind === "replacement" ? expected : expected.slice(0, -"/replacement".length);
        equality = entry.target === wanted ? "equal" : "different";
      }
      reservations.push({
        kind: entry.kind,
        site: entry.site,
        target,
        lexical: equality,
        process: entry.process,
        canonical: entry.canonical,
      });
    }
    return JSON.stringify({
      schema: "delivery-overlap-observer.v1",
      slot,
      pid: process.pid,
      executions: this.executions,
      anchors: this.anchors,
      sites: this.sites,
      roles: this.roles,
      unattributed: this.unattributed,
      reservations,
      writes: this.writes,
      calledElsewhere: this.calledElsewhere,
      dropped: this.dropped,
    });
  }
}

export default Plugin({
  name: "delivery-overlap-observer",
  *install(request) {
    const slot = yield* env("XMD_OVERLAP_SLOT");
    const report = yield* env("XMD_OVERLAP_REPORT");
    const called = yield* env("XMD_OVERLAP_CALLED");
    const replacement = yield* env("XMD_OVERLAP_REPLACEMENT");
    if (
      request.command !== "run" ||
      (slot !== "first" && slot !== "second") ||
      report === undefined ||
      called === undefined ||
      replacement === undefined
    ) {
      return undefined;
    }
    const observation = new Observation();
    yield* ensure(function* () {
      try {
        yield* writeTextFile(report, yield* observation.report(slot, replacement));
      } catch {
        // A diagnostic that cannot be written leaves its report absent; the
        // command's own outcome is what the overlap asserts on.
      }
    });
    yield* API.Process.around({
      *exec([options], next) {
        const content =
          options.command[0] === "bash" && options.command[1] === "-c"
            ? options.command[2]
            : undefined;
        if (content === undefined || !content.startsWith("mkdir -- ")) {
          return yield* next(options);
        }
        const target = decode(content, options.cwd);
        const entry = observation.reservation({
          kind: kind(target),
          site: "none",
          content,
          target,
          process: "unsettled",
          canonical: "none",
        });
        try {
          const outcome = yield* next(options);
          entry.process = Number.isSafeInteger(outcome?.exitCode) ? outcome.exitCode : "absent";
          return outcome;
        } catch (error) {
          entry.process = "thrown";
          throw error;
        }
      },
    });
    yield* API.Files.around({
      *writeTextFile([input], next) {
        const path = input.path.startsWith("/") ? input.path : input.cwd + "/" + input.path;
        if (path !== called) {
          if (path.endsWith("/called.json")) {
            observation.calledElsewhere = Math.min(COUNT, observation.calledElsewhere + 1);
          }
          return yield* next(input);
        }
        const entry = observation.write({ ...positions(input.content), settled: "unsettled" });
        try {
          const result = yield* next(input);
          entry.settled = result.ok ? "ok" : "err";
          return result;
        } catch (error) {
          entry.settled = "thrown";
          throw error;
        }
      },
    });
    yield* Execution.around({
      *execute([execution], next) {
        observation.executions = Math.min(COUNT, observation.executions + 1);
        if (observation.executions !== 1) {
          return yield* next(execution);
        }
        const stream = execution.options.stream;
        const observed: DurableStream = {
          readAll: () => stream.readAll(),
          *append(event) {
            yield* stream.append(event);
            observation.inspect(event);
          },
        };
        return yield* next(
          execution.withOptions({
            ...execution.options,
            stream: preserveJournalProvenance(stream, observed),
          }),
        );
      },
    });
    return undefined;
  },
});
