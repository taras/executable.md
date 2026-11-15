import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Err, Ok, sleep } from "effection";
import { entryBoundary, settlesRoot } from "./entries.ts";
import type { Operation, Result } from "effection";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import { scanEntryRecords } from "./journal-records.ts";
import {
  fileFingerprint,
  JournalChangedError,
  journalVersion,
  sameJournal,
  type JournalAppend,
  type JournalVersion,
} from "./record-file.ts";
import { modelFromEntries, projectEntryRange, ReplProjectionError } from "./model.ts";
import type { ReplBinding, ReplEntry, ReplModel, ReplScope } from "./model.ts";

interface Page {
  readonly start: number;
  readonly end: number;
  readonly sha256: string;
  readonly entry: ReplEntry;
}

interface Selection {
  readonly at: string | undefined;
  readonly order: number;
  readonly selected: ReplEntry | undefined;
  readonly prefix: ReplEntry | undefined;
}

function omitScopeValues(scope: ReplScope): ReplScope {
  return Object.freeze({
    ...scope,
    archived: true,
    bindings: Object.freeze([]),
    scopes: Object.freeze(scope.scopes.map(omitScopeValues)),
  });
}

function archive(entry: ReplEntry): ReplEntry {
  return Object.freeze({
    ...entry,
    archived: true,
    bindings: Object.freeze([]),
    scope: omitScopeValues(entry.scope),
    terminal:
      entry.terminal === undefined
        ? undefined
        : Object.freeze({ ...entry.terminal, bindings: undefined }),
  });
}

export type EntryRestoreProgress =
  | { readonly stage: "counting" }
  | { readonly stage: "rounds"; readonly restored: number; readonly total: number | undefined };

export type EntryRestoreObserver = (progress: EntryRestoreProgress) => Operation<void>;

function* countEntryRanges(
  path: string,
  version: JournalVersion,
): Operation<{ total: number; sha256: string } | undefined> {
  const hash = createHash("sha256");
  let open = false;
  let total = 0;
  let records = 0;
  let bytes = 0;
  try {
    yield* scanEntryRecords(
      path,
      {
        retain: false,
        observe(chunk) {
          bytes += chunk.length;
          hash.update(chunk);
        },
      },
      function* (event) {
        const boundary = entryBoundary(event, open, total > 0);
        if (!boundary.ok) {
          throw boundary.error;
        }
        if (boundary.value === "close") {
          total += 1;
          open = false;
        } else if (boundary.value !== undefined) {
          open = true;
        }
        records += 1;
        if (records % 128 === 0) {
          yield* sleep(0);
        }
      },
    );
  } catch {
    // Projection preserves the canonical refusal and the ranges it could read.
    return undefined;
  }
  if (BigInt(bytes) !== version.size) {
    throw new JournalChangedError();
  }
  return { total: total + Number(open), sha256: hash.digest("hex") };
}

/** The catalog and byte ranges for one validated, acknowledged entry journal. */
export class PagedHistory {
  private readonly pages: Page[] = [];
  private readonly positions = new Map<string, { order: number; length: number }>();
  private tail: DurableEvent[] = [];
  private readonly whole = createHash("sha256");
  private segment = createHash("sha256");
  private start = 0;
  private end = 0;
  private latest: ReplEntry | undefined;
  private environment: readonly ReplBinding[] = [];
  private readonly publishers = new Map<string, number[]>();
  private selection: Selection | undefined;
  private failure: Error | undefined;
  private records = 0;

  private constructor(
    private path: string,
    private version: JournalVersion,
  ) {}

  static *open(path: string, observe?: EntryRestoreObserver): Operation<PagedHistory> {
    const version = yield* journalVersion(path);
    const history = new PagedHistory(path, version);
    let counted: { total: number; sha256: string } | undefined;
    let restored = 0;
    const progress = function* (): Operation<void> {
      if (observe !== undefined) {
        yield* observe({ stage: "rounds", restored, total: counted?.total });
      }
    };
    const confirm = function* (): Operation<void> {
      try {
        yield* history.confirmVersion();
      } catch (error) {
        counted = undefined;
        yield* progress();
        throw error;
      }
    };

    if (observe !== undefined) {
      yield* observe({ stage: "counting" });
      counted = yield* countEntryRanges(path, version);
      yield* confirm();
      yield* progress();
      yield* confirm();
    }

    const project = function* (): Operation<void> {
      history.projectTail();
      restored += 1;
      if (counted !== undefined && restored > counted.total) {
        counted = undefined;
        yield* progress();
        throw new JournalChangedError();
      }
      yield* progress();
    };

    try {
      yield* scanEntryRecords(
        path,
        {
          recordBytes: (bytes) => history.count(bytes),
          segmentSharing: true,
        },
        function* (event) {
          history.tail.push(event);
          history.records += 1;
          if (settlesRoot(event)) {
            yield* project();
          } else if (observe !== undefined && history.records % 128 === 0) {
            yield* sleep(0);
          }
        },
      );
      if (history.tail.length > 0) {
        yield* project();
      }
    } catch (error) {
      if (counted !== undefined) {
        const fingerprint = yield* fileFingerprint(path);
        if (fingerprint.sha256 !== counted.sha256) {
          counted = undefined;
          yield* progress();
          throw new JournalChangedError();
        }
        yield* confirm();
      }
      throw error;
    }
    yield* confirm();
    if (
      BigInt(history.end) !== version.size ||
      (counted !== undefined && (history.digest !== counted.sha256 || restored !== counted.total))
    ) {
      counted = undefined;
      yield* progress();
      throw new JournalChangedError();
    }
    return history;
  }

  get recordCount(): number {
    return this.records;
  }

  get activeEvents(): readonly DurableEvent[] {
    return this.tail;
  }

  get digest(): string {
    return this.whole.copy().digest("hex");
  }

  get fingerprint(): { records: number; bytes: number; sha256: string } {
    return { records: this.records, bytes: this.end, sha256: this.digest };
  }

  *confirmVersion(): Operation<void> {
    this.requireReadable();
    try {
      if (!sameJournal(this.version, yield* journalVersion(this.path))) {
        throw new JournalChangedError();
      }
    } catch (cause) {
      throw this.fence(new JournalChangedError({ cause }));
    }
  }

  *prepareRelocation(path: string, digest: string): Operation<JournalVersion> {
    if (digest !== this.digest) {
      throw this.fence(new JournalChangedError());
    }
    const version = yield* journalVersion(path);
    const copy = yield* fileFingerprint(path);
    if (
      copy.sha256 !== digest ||
      copy.bytes !== this.end ||
      !sameJournal(version, yield* journalVersion(path))
    ) {
      throw new JournalChangedError();
    }
    return version;
  }

  relocate(path: string, version: JournalVersion): void {
    this.path = path;
    this.version = version;
  }

  fence(error: Error): Error {
    this.failure ??= error;
    return this.failure;
  }

  checkAppend(): JournalAppend {
    this.requireReadable();
    return {
      version: this.version,
      sha256: this.digest,
      permit: () => this.requireReadable(),
      acknowledged: (written) => {
        this.version = written;
      },
    };
  }

  acknowledge(event: DurableEvent, text: string): void {
    this.whole.update(text, "utf8");
    this.segment.update(text, "utf8");
    this.end += Buffer.byteLength(text);
    this.records += 1;
    this.tail.push(event);
    try {
      this.projectTail();
    } catch (cause) {
      this.fence(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  head(): Result<ReplModel> {
    if (this.failure !== undefined) {
      return Err(this.failure);
    }
    return Ok(this.model(undefined));
  }

  reading(at: string | undefined, resident = true): Result<ReplModel> {
    if (this.failure !== undefined) {
      return Err(this.failure);
    }
    if (at !== undefined && !this.positions.has(at)) {
      return Err(
        new ReplProjectionError(
          "the selected history position is not in this journal. Return to the live head and " +
            "choose a checkpoint the history offers.",
        ),
      );
    }
    const selection = this.selection?.at === at ? this.selection : undefined;
    return Ok(
      this.model(
        at,
        resident || selection === undefined ? selection : { ...selection, selected: undefined },
      ),
    );
  }

  /** Initial bindings for the unfinished final segment. */
  resumeBindings(): Readonly<Record<string, Json>> {
    return Object.freeze(
      Object.fromEntries(this.environment.map(({ name, value }) => [name, value])),
    );
  }

  *attend(at: string | undefined, key: string | undefined): Operation<Result<ReplModel>> {
    const available = this.reading(at);
    if (!available.ok) {
      return available;
    }
    const order = available.value.entries.find((entry) => entry.key === key)?.order ?? 0;
    const marker = at === undefined ? undefined : this.positions.get(at);
    if (this.selection?.at === at && this.selection?.order === order) {
      return available;
    }
    try {
      // A live range may become a page during I/O. A second pass loads that
      // page if this route crosses the boundary while the first one is read.
      for (;;) {
        const settled = this.pages.length;
        const page = marker === undefined ? undefined : this.pages[marker.order - 1];
        const partial =
          marker !== undefined && page !== undefined && marker.length < page.entry.records.length;
        const selectedLength = marker?.order === order ? marker.length : undefined;
        const selected =
          order > 0 && order <= settled ? yield* this.loadEntry(order, selectedLength) : undefined;
        const prefix =
          partial && marker.order !== order
            ? archive(yield* this.loadEntry(marker.order, marker.length, false))
            : undefined;
        if (settled < this.pages.length && (order > settled || (marker?.order ?? 0) > settled)) {
          continue;
        }
        this.requireReadable();
        this.selection = { at, order, selected, prefix };
        return this.reading(at);
      }
    } catch (cause) {
      return Err(this.fence(new JournalChangedError({ cause })));
    }
  }

  *readAll(): Operation<DurableEvent[]> {
    this.requireReadable();
    const events: DurableEvent[] = [];
    const hash = createHash("sha256");
    const expected = this.digest;
    yield* scanEntryRecords(
      this.path,
      {
        range: { start: 0, end: this.end },
        observe: (bytes) => hash.update(bytes),
        segmentSharing: true,
      },
      // deno-lint-ignore require-yield
      function* (event) {
        events.push(event);
      },
    );
    if (hash.digest("hex") !== expected) {
      throw this.fence(new JournalChangedError());
    }
    this.requireReadable();
    return events;
  }

  private requireReadable(): void {
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }

  private count(bytes: Uint8Array): void {
    this.whole.update(bytes);
    this.segment.update(bytes);
    this.end += bytes.length;
  }

  private projectTail(): void {
    const order = this.pages.length + 1;
    const projected = projectEntryRange(this.tail, order, this.environment);
    if (!projected.ok) {
      throw projected.error;
    }
    const entry = projected.value;
    for (const [index, record] of entry.records.entries()) {
      this.positions.set(record.marker, { order, length: index + 1 });
    }
    if (entry.settled) {
      this.pages.push({
        start: this.start,
        end: this.end,
        sha256: this.segment.digest("hex"),
        entry: archive(entry),
      });
      for (const binding of entry.scope.bindings) {
        if (binding.name === "props") {
          continue;
        }
        const orders = this.publishers.get(binding.name);
        if (orders === undefined) {
          this.publishers.set(binding.name, [order]);
        } else {
          orders.push(order);
        }
      }
      this.environment = entry.bindings;
      this.segment = createHash("sha256");
      this.start = this.end;
      this.tail = [];
    }
    if (this.selection !== undefined && entry.settled) {
      const position =
        this.selection.at === undefined ? undefined : this.positions.get(this.selection.at);
      if (this.selection.order === order || position?.order === order) {
        this.selection = undefined;
      }
    }
    this.latest = entry.settled ? entry : Object.freeze({ ...entry, pagedInput: this.environment });
  }

  private model(at: string | undefined, selection?: Selection): ReplModel {
    const limit = at === undefined ? undefined : this.positions.get(at);
    const maximum = limit?.order ?? this.pages.length + (this.tail.length > 0 ? 1 : 0);
    const entries = this.pages.slice(0, maximum).map(({ entry }) => entry);
    const latest = this.latest;
    if (latest !== undefined && latest.order <= maximum) {
      if (
        limit === undefined ||
        (limit.order === latest.order && limit.length === latest.records.length)
      ) {
        entries[latest.order - 1] = latest;
      } else if (limit.order === latest.order && this.tail.length > 0) {
        const partial = projectEntryRange(
          this.tail.slice(0, limit.length),
          latest.order,
          this.environment,
        );
        if (!partial.ok) {
          throw partial.error;
        }
        entries[latest.order - 1] = Object.freeze({
          ...partial.value,
          pagedInput: this.environment,
        });
      }
    }
    if (selection?.prefix !== undefined) {
      entries[selection.prefix.order - 1] = selection.prefix;
    }
    if (selection?.selected !== undefined) {
      entries[selection.selected.order - 1] = selection.selected;
    }
    return modelFromEntries(entries, at, at === undefined || latest?.records.at(-1)?.marker === at);
  }

  private *loadEntry(order: number, length?: number, withInput = true): Operation<ReplEntry> {
    const input = withInput ? yield* this.loadInput(order) : [];
    const events = yield* this.readPage(order);
    const projected = projectEntryRange(events.slice(0, length), order, input);
    if (!projected.ok) {
      throw projected.error;
    }
    return Object.freeze({ ...projected.value, pagedInput: Object.freeze(input) });
  }

  private *loadInput(order: number): Operation<ReplBinding[]> {
    const input = new Map<string, ReplBinding | undefined>();
    const namesByPage = new Map<number, Set<string>>();
    for (const [name, orders] of this.publishers) {
      const publisher = orders.findLast((candidate) => candidate < order);
      if (publisher === undefined) {
        continue;
      }
      input.set(name, undefined);
      const names = namesByPage.get(publisher) ?? new Set<string>();
      names.add(name);
      namesByPage.set(publisher, names);
    }
    for (const [publisher, names] of namesByPage) {
      const projected = projectEntryRange(yield* this.readPage(publisher), publisher, []);
      if (!projected.ok) {
        throw projected.error;
      }
      for (const binding of projected.value.scope.bindings) {
        if (names.has(binding.name)) {
          input.set(binding.name, binding);
        }
      }
    }
    return [...input.values()].map((binding) => {
      if (binding === undefined) {
        throw new JournalChangedError();
      }
      return binding;
    });
  }

  private *readPage(order: number): Operation<readonly DurableEvent[]> {
    this.requireReadable();
    const page = this.pages[order - 1];
    if (page === undefined) {
      throw new JournalChangedError();
    }
    const events: DurableEvent[] = [];
    const hash = createHash("sha256");
    let length = 0;
    yield* scanEntryRecords(
      this.path,
      {
        range: page,
        observe: (bytes) => {
          length += bytes.length;
          hash.update(bytes);
        },
      },
      // deno-lint-ignore require-yield
      function* (event) {
        events.push(event);
      },
    );
    if (length !== page.end - page.start || hash.digest("hex") !== page.sha256) {
      throw new JournalChangedError();
    }
    this.requireReadable();
    return events;
  }
}
