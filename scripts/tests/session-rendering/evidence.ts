/**
 * What a journey has to have shown, and what it means when it has not.
 *
 * One checker admits the positive journey and rejects every mutation, so a
 * control that "fails" cannot be failing for a reason nobody named: each
 * rejection carries the invariant category of the claim it broke. The same
 * module parses the JSON a journey process printed, which is what lets the
 * source run and the compiled run be compared as values rather than as text.
 *
 * Parsing is how types arrive here. Nothing is cast: a record that does not
 * have the shape below is not a report, and saying so is more useful than
 * asserting against fields that were never there.
 */

import { EMPHASIS_ATTRIBUTE, lexProofMarkdown } from "./markdown-projection.ts";
import type { OperationDescription } from "./markdown-projection.ts";

/** The claim a rejection belongs to. */
export const INVARIANT_CATEGORIES = [
  "presentation-selection",
  "override-precedence",
  "structured-markdown",
  "stable-replacement",
  "coalescing",
  "history-and-newest",
  "follow-unread",
  "resize-preservation",
  "bounded-diff",
  "forbidden-integration",
] as const;

export type InvariantCategory = (typeof INVARIANT_CATEGORIES)[number];

export interface Violation {
  readonly category: InvariantCategory;
  readonly detail: string;
}

/** The seven names this proof selects, in the order history holds them. */
export const PRESENTATION_COMPONENTS: readonly string[] = [
  "Session.Message.User",
  "Session.Message.Assistant",
  "Session.Message.Tool",
  "Session.Message.Permission",
  "Session.Message.Status",
  "Session.Message.Unknown",
  "Session.Message.Thought",
];

/** The name the repository-local override renders, which no default may print. */
export const REPOSITORY_TOOL_MARKER = "xmd-proof-tool-repository";

export const EXPECTED_HISTORY: readonly string[] = [
  "entry-user",
  "entry-assistant",
  "entry-tool",
  "entry-permission",
  "entry-status",
  "entry-unknown",
  "entry-thought",
  "entry-appended",
  "entry-final",
];

const THOUGHT_ID = "entry-thought";

export class ReportShapeError extends Error {
  constructor(field: string) {
    super(`the journey record has no ${field}`);
    this.name = "ReportShapeError";
  }
}

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || !(name in value)) {
    throw new ReportShapeError(name);
  }
  return Reflect.get(value, name);
}

function asString(value: unknown, name: string): string {
  const found = field(value, name);
  if (typeof found !== "string") {
    throw new ReportShapeError(`${name} as a string`);
  }
  return found;
}

function asNumber(value: unknown, name: string): number {
  const found = field(value, name);
  if (typeof found !== "number") {
    throw new ReportShapeError(`${name} as a number`);
  }
  return found;
}

function asBoolean(value: unknown, name: string): boolean {
  const found = field(value, name);
  if (typeof found !== "boolean") {
    throw new ReportShapeError(`${name} as a boolean`);
  }
  return found;
}

function asArray(value: unknown, name: string): unknown[] {
  const found = field(value, name);
  if (!Array.isArray(found)) {
    throw new ReportShapeError(`${name} as an array`);
  }
  return found;
}

function asStrings(value: unknown, name: string): string[] {
  return asArray(value, name).map((entry) => {
    if (typeof entry !== "string") {
      throw new ReportShapeError(`${name} as strings`);
    }
    return entry;
  });
}

export interface ParsedPresentation {
  readonly component: string;
  readonly path: string;
  readonly root: string;
}

export interface ParsedProjection {
  readonly id: string;
  readonly component: string;
  readonly componentPath: string;
  readonly revision: number;
  readonly complete: boolean;
  readonly raw: string;
}

export interface ParsedCommit {
  readonly id: string;
  readonly revision: number;
  readonly complete: boolean;
  readonly viewVersion: number;
}

export interface ParsedFrame {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly visible: readonly string[];
  readonly anchor: string;
  readonly follow: boolean;
  readonly unread: number;
  readonly bytes: number;
  readonly operations: readonly OperationDescription[];
}

export interface ParsedReport {
  readonly schema: string;
  readonly dependency: { readonly name: string; readonly version: string };
  readonly authorities: Readonly<Record<string, string>>;
  readonly presentations: readonly ParsedPresentation[];
  readonly projections: readonly ParsedProjection[];
  readonly history: readonly string[];
  readonly commits: readonly ParsedCommit[];
  readonly timeline: readonly string[];
  readonly barrier: {
    readonly ingestedWhileBlocked: readonly number[];
    readonly releasedAfterVersion: number;
    readonly committedAfterRelease: readonly ParsedCommit[];
  };
  readonly frames: readonly ParsedFrame[];
  readonly resize: {
    readonly requested: readonly { readonly width: number; readonly height: number }[];
    readonly adopted: { readonly width: number; readonly height: number };
    readonly anchorBefore: string;
    readonly anchorAfter: string;
    readonly followBefore: boolean;
    readonly followAfter: boolean;
    readonly unreadBefore: number;
    readonly unreadAfter: number;
    readonly historyBefore: readonly string[];
    readonly historyAfter: readonly string[];
  };
  readonly diff: {
    readonly incrementalBytes: number;
    readonly freshBytes: number;
    readonly neighbours: readonly string[];
    readonly neighboursBefore: readonly OperationDescription[];
    readonly neighboursAfter: readonly OperationDescription[];
  };
  readonly files: readonly {
    readonly operation: string;
    readonly path: string;
    readonly admitted: boolean;
  }[];
  readonly discardedProjections: number;
}

function parseOperations(value: unknown, name: string): OperationDescription[] {
  return asArray(value, name).map((entry) => {
    const kind = asString(entry, "kind");
    if (kind === "open") {
      const role = asString(entry, "role");
      if (role !== "viewport" && role !== "entry" && role !== "paragraph" && role !== "code") {
        throw new ReportShapeError(`${name} with a known role`);
      }
      return { kind: "open", id: asString(entry, "id"), role };
    }
    if (kind === "text") {
      return { kind: "text", content: asString(entry, "content"), attrs: asNumber(entry, "attrs") };
    }
    if (kind === "close") {
      return { kind: "close" };
    }
    throw new ReportShapeError(`${name} with a known operation kind`);
  });
}

function parseCommits(value: unknown, name: string): ParsedCommit[] {
  return asArray(value, name).map((entry) => ({
    id: asString(entry, "id"),
    revision: asNumber(entry, "revision"),
    complete: asBoolean(entry, "complete"),
    viewVersion: asNumber(entry, "viewVersion"),
  }));
}

function parseSize(value: unknown): { width: number; height: number } {
  return { width: asNumber(value, "width"), height: asNumber(value, "height") };
}

/** One journey record, parsed into the shape the oracles read. */
export function parseJourneyReport(value: unknown): ParsedReport {
  const dependency = field(value, "dependency");
  const authoritiesValue = field(value, "authorities");
  if (typeof authoritiesValue !== "object" || authoritiesValue === null) {
    throw new ReportShapeError("authorities");
  }
  const authorities: Record<string, string> = {};
  for (const [name, state] of Object.entries(authoritiesValue)) {
    if (typeof state !== "string") {
      throw new ReportShapeError("authorities as strings");
    }
    authorities[name] = state;
  }
  const barrier = field(value, "barrier");
  const resize = field(value, "resize");
  const diff = field(value, "diff");
  return {
    schema: asString(value, "schema"),
    dependency: { name: asString(dependency, "name"), version: asString(dependency, "version") },
    authorities,
    presentations: asArray(value, "presentations").map((entry) => ({
      component: asString(entry, "component"),
      path: asString(entry, "path"),
      root: asString(entry, "root"),
    })),
    projections: asArray(value, "projections").map((entry) => ({
      id: asString(entry, "id"),
      component: asString(entry, "component"),
      componentPath: asString(entry, "componentPath"),
      revision: asNumber(entry, "revision"),
      complete: asBoolean(entry, "complete"),
      raw: asString(entry, "raw"),
    })),
    history: asStrings(value, "history"),
    commits: parseCommits(value, "commits"),
    timeline: asStrings(value, "timeline"),
    barrier: {
      ingestedWhileBlocked: asArray(barrier, "ingestedWhileBlocked").map((entry) => {
        if (typeof entry !== "number") {
          throw new ReportShapeError("ingestedWhileBlocked as numbers");
        }
        return entry;
      }),
      releasedAfterVersion: asNumber(barrier, "releasedAfterVersion"),
      committedAfterRelease: parseCommits(barrier, "committedAfterRelease"),
    },
    frames: asArray(value, "frames").map((entry) => ({
      label: asString(entry, "label"),
      width: asNumber(entry, "width"),
      height: asNumber(entry, "height"),
      visible: asStrings(entry, "visible"),
      anchor: asString(entry, "anchor"),
      follow: asBoolean(entry, "follow"),
      unread: asNumber(entry, "unread"),
      bytes: asNumber(entry, "bytes"),
      operations: parseOperations(entry, "operations"),
    })),
    resize: {
      requested: asArray(resize, "requested").map(parseSize),
      adopted: parseSize(field(resize, "adopted")),
      anchorBefore: asString(resize, "anchorBefore"),
      anchorAfter: asString(resize, "anchorAfter"),
      followBefore: asBoolean(resize, "followBefore"),
      followAfter: asBoolean(resize, "followAfter"),
      unreadBefore: asNumber(resize, "unreadBefore"),
      unreadAfter: asNumber(resize, "unreadAfter"),
      historyBefore: asStrings(resize, "historyBefore"),
      historyAfter: asStrings(resize, "historyAfter"),
    },
    diff: {
      incrementalBytes: asNumber(diff, "incrementalBytes"),
      freshBytes: asNumber(diff, "freshBytes"),
      neighbours: asStrings(diff, "neighbours"),
      neighboursBefore: parseOperations(diff, "neighboursBefore"),
      neighboursAfter: parseOperations(diff, "neighboursAfter"),
    },
    files: asArray(value, "files").map((entry) => ({
      operation: asString(entry, "operation"),
      path: asString(entry, "path"),
      admitted: asBoolean(entry, "admitted"),
    })),
    discardedProjections: asNumber(value, "discardedProjections"),
  };
}

function frameNamed(report: ParsedReport, label: string): ParsedFrame | undefined {
  return report.frames.find((frame) => frame.label === label);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The first visible line of a rendering, which is the presentation's marker. */
function markerOf(raw: string): string {
  return (
    raw
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function checkPresentations(report: ParsedReport, violations: Violation[]): void {
  const reject = (detail: string) =>
    violations.push({ category: "presentation-selection", detail });

  if (
    !same(
      report.presentations.map((one) => one.component),
      PRESENTATION_COMPONENTS,
    )
  ) {
    reject(
      `selected ${report.presentations.length} names (${report.presentations
        .map((one) => one.component)
        .join(", ")})`,
    );
    return;
  }
  for (const presentation of report.presentations) {
    const leaf = presentation.component.split(".").join("/");
    const expected = `${presentation.root}/${leaf}.md`;
    if (presentation.path !== expected) {
      reject(`${presentation.component} resolved to ${presentation.path}, not ${expected}`);
    }
  }
  const markers = new Map<string, Set<string>>();
  for (const projection of report.projections) {
    const seen = markers.get(projection.component) ?? new Set<string>();
    seen.add(markerOf(projection.raw));
    markers.set(projection.component, seen);
  }
  const distinct = new Set<string>();
  for (const component of PRESENTATION_COMPONENTS) {
    const seen = markers.get(component);
    if (seen === undefined || seen.size !== 1) {
      reject(`${component} rendered ${seen === undefined ? 0 : seen.size} distinct markers`);
      continue;
    }
    const [marker] = [...seen];
    if (marker.length === 0) {
      reject(`${component} rendered no marker`);
    }
    distinct.add(marker);
  }
  if (distinct.size !== PRESENTATION_COMPONENTS.length) {
    reject(`the seven presentations share ${distinct.size} markers`);
  }
}

function checkOverride(report: ParsedReport, violations: Violation[]): void {
  const reject = (detail: string) => violations.push({ category: "override-precedence", detail });
  for (const presentation of report.presentations) {
    const expected =
      presentation.component === "Session.Message.Tool" ? "repository/components" : "defaults";
    if (presentation.root !== expected) {
      reject(`${presentation.component} came from ${presentation.root}, not ${expected}`);
    }
  }
  const tool = report.projections.filter((one) => one.component === "Session.Message.Tool");
  if (tool.length === 0) {
    reject("no Tool projection was committed");
  }
  for (const projection of tool) {
    if (markerOf(projection.raw) !== REPOSITORY_TOOL_MARKER) {
      reject(`the Tool rendering printed ${markerOf(projection.raw)}`);
    }
  }
}

function checkStructuredMarkdown(report: ParsedReport, violations: Violation[]): void {
  const reject = (detail: string) => violations.push({ category: "structured-markdown", detail });

  let paragraphs = 0;
  let emphasised = 0;
  let fenced = 0;
  for (const projection of report.projections) {
    const blocks = lexProofMarkdown(projection.raw);
    paragraphs = Math.max(paragraphs, blocks.filter((block) => block.kind === "paragraph").length);
    for (const block of blocks) {
      if (block.kind === "paragraph" && block.runs.some((run) => run.emphasis)) {
        emphasised++;
      }
      if (block.kind === "code" && block.language === "ts") {
        fenced++;
      }
    }
  }
  if (paragraphs < 2) {
    reject(`the widest capture held ${paragraphs} paragraph(s)`);
  }
  if (emphasised === 0) {
    reject("no capture carried inline emphasis");
  }
  if (fenced === 0) {
    reject("no capture carried a fenced TypeScript block");
  }

  // Read every frame: the entry carrying the fenced block is not on screen in
  // all of them, and what this claim is about is that the projection put the
  // three shapes into the operation tree at all.
  const ops = report.frames.flatMap((frame) => frame.operations);
  if (ops.length === 0) {
    reject("there are no frames to read operations from");
    return;
  }
  if (!ops.some((op) => op.kind === "open" && op.role === "paragraph")) {
    reject("the operation tree has no paragraph container");
  }
  if (!ops.some((op) => op.kind === "text" && op.attrs === EMPHASIS_ATTRIBUTE)) {
    reject("no text operation carries the emphasis attribute");
  }
  const code = ops.findIndex((op) => op.kind === "open" && op.role === "code");
  if (code === -1) {
    reject("the operation tree has no code container");
    return;
  }
  const inside = ops[code + 1];
  if (inside === undefined || inside.kind !== "text" || inside.content.length === 0) {
    reject("the code container holds no text operation");
  }
}

function checkStableReplacement(report: ParsedReport, violations: Violation[]): void {
  const reject = (detail: string) => violations.push({ category: "stable-replacement", detail });

  if (!same(report.history, EXPECTED_HISTORY)) {
    reject(`history is ${report.history.join(", ")}`);
  }
  if (new Set(report.history).size !== report.history.length) {
    reject("history holds a duplicate id");
  }
  const thoughtCommits = report.commits.filter((commit) => commit.id === THOUGHT_ID);
  const last = thoughtCommits[thoughtCommits.length - 1];
  if (last === undefined || last.revision !== 5 || !last.complete) {
    reject(`the thought's last commit is ${JSON.stringify(last ?? null)}`);
  }
  if (!same(report.diff.neighboursBefore, report.diff.neighboursAfter)) {
    reject(`the neighbours ${report.diff.neighbours.join(", ")} changed across the replacement`);
  }
  const initial = frameNamed(report, "initial");
  const completion = frameNamed(report, "thought-completion");
  if (initial === undefined || completion === undefined) {
    reject("the replacement frames are missing");
    return;
  }
  if (initial.visible.indexOf(THOUGHT_ID) !== completion.visible.indexOf(THOUGHT_ID)) {
    reject("the replacement moved the thought within the visible frame");
  }
}

function checkCoalescing(report: ParsedReport, violations: Violation[]): void {
  const reject = (detail: string) => violations.push({ category: "coalescing", detail });

  if (report.barrier.ingestedWhileBlocked.length !== 3) {
    reject(`${report.barrier.ingestedWhileBlocked.length} snapshot(s) arrived while blocked`);
  }
  const after = report.barrier.committedAfterRelease;
  if (after.length !== 1) {
    reject(`${after.length} projection(s) committed after the barrier opened`);
  }
  const only = after[0];
  if (only === undefined || only.id !== THOUGHT_ID || only.revision !== 5 || !only.complete) {
    reject(`the first commit after release is ${JSON.stringify(only ?? null)}`);
  }
  if (report.discardedProjections < 1) {
    reject("no stale projection was discarded");
  }
  const engaged = report.timeline.indexOf("barrier:engaged");
  const released = report.timeline.indexOf("barrier:released");
  const resumed = report.timeline.indexOf("barrier:resumed");
  if (engaged === -1 || released === -1 || resumed === -1 || !(engaged < released)) {
    reject(`the barrier timeline is ${report.timeline.join(" ")}`);
    return;
  }
  for (const version of report.barrier.ingestedWhileBlocked) {
    const at = report.timeline.indexOf(`ingest:v${version}`);
    if (!(at > engaged && at < released)) {
      reject(`snapshot ${version} was not ingested between engaging and releasing`);
    }
  }
}

function checkHistoryAndNewest(report: ParsedReport, violations: Violation[]): void {
  const reject = (detail: string) => violations.push({ category: "history-and-newest", detail });

  const initial = frameNamed(report, "initial");
  const scrolled = frameNamed(report, "scrolled-to-oldest");
  if (initial === undefined || scrolled === undefined) {
    reject("the history frames are missing");
    return;
  }
  if (!initial.follow || initial.unread !== 0) {
    reject(`the initial frame is follow=${initial.follow} unread=${initial.unread}`);
  }
  if (!initial.visible.includes(THOUGHT_ID)) {
    reject("the initial frame does not show the newest entry");
  }
  if (scrolled.follow) {
    reject("paging up left the view following");
  }
  if (scrolled.anchor !== report.history[0]) {
    reject(`paging up reached ${scrolled.anchor}, not ${report.history[0]}`);
  }
  for (const id of EXPECTED_HISTORY) {
    if (!report.history.includes(id)) {
      reject(`history lost ${id}`);
    }
  }
}

function checkFollowAndUnread(report: ParsedReport, violations: Violation[]): void {
  const reject = (detail: string) => violations.push({ category: "follow-unread", detail });

  const scrolled = frameNamed(report, "scrolled-to-oldest");
  const appended = frameNamed(report, "appended-off-bottom");
  const returned = frameNamed(report, "returned-to-bottom");
  const following = frameNamed(report, "appended-while-following");
  if (
    scrolled === undefined ||
    appended === undefined ||
    returned === undefined ||
    following === undefined
  ) {
    reject("the follow frames are missing");
    return;
  }
  if (appended.anchor !== scrolled.anchor) {
    reject(`the append moved the anchor from ${scrolled.anchor} to ${appended.anchor}`);
  }
  if (appended.follow) {
    reject("the append re-enabled following");
  }
  if (appended.unread !== 1) {
    reject(`the append left unread at ${appended.unread}`);
  }
  if (!returned.follow || returned.unread !== 0) {
    reject(`End left follow=${returned.follow} unread=${returned.unread}`);
  }
  if (!returned.visible.includes("entry-appended")) {
    reject("End did not return to the newest entry");
  }
  if (!following.follow || following.unread !== 0) {
    reject(`the following append left follow=${following.follow} unread=${following.unread}`);
  }
  if (!following.visible.includes("entry-final")) {
    reject("the following append did not stay at the newest entry");
  }
}

function checkResize(report: ParsedReport, violations: Violation[]): void {
  const reject = (detail: string) => violations.push({ category: "resize-preservation", detail });

  const last = report.resize.requested[report.resize.requested.length - 1];
  if (last === undefined || !same(last, report.resize.adopted)) {
    reject(`the batch adopted ${JSON.stringify(report.resize.adopted)}`);
  }
  const resized = frameNamed(report, "resized");
  if (resized === undefined) {
    reject("there is no resized frame");
    return;
  }
  if (
    resized.width !== report.resize.adopted.width ||
    resized.height !== report.resize.adopted.height
  ) {
    reject(`the resized frame rendered ${resized.width}x${resized.height}`);
  }
  if (!same(report.resize.historyBefore, report.resize.historyAfter)) {
    reject("the resize changed history");
  }
  // The anchor claim is about an off-bottom view. A following view is supposed
  // to re-anchor when the window grows, and whether this journey was off the
  // bottom at all is the follow-and-unread claim rather than this one.
  if (report.resize.followBefore) {
    return;
  }
  if (report.resize.anchorBefore !== report.resize.anchorAfter) {
    reject(
      `the resize moved the anchor from ${report.resize.anchorBefore} to ${report.resize.anchorAfter}`,
    );
  }
  if (report.resize.followBefore !== report.resize.followAfter) {
    reject("the resize changed follow mode");
  }
  if (report.resize.unreadBefore !== report.resize.unreadAfter) {
    reject("the resize changed the unread count");
  }
}

function checkBoundedDiff(report: ParsedReport, violations: Violation[]): void {
  const reject = (detail: string) => violations.push({ category: "bounded-diff", detail });

  if (report.diff.incrementalBytes === 0) {
    reject("the incremental update produced no bytes");
  }
  if (report.diff.incrementalBytes >= report.diff.freshBytes) {
    reject(
      `the incremental update cost ${report.diff.incrementalBytes} bytes against a fresh frame of ${report.diff.freshBytes}`,
    );
  }
  if (!same(report.diff.neighboursBefore, report.diff.neighboursAfter)) {
    reject("the measured update also changed its neighbours");
  }
}

function checkForbiddenIntegration(report: ParsedReport, violations: Violation[]): void {
  const reject = (detail: string) => violations.push({ category: "forbidden-integration", detail });

  if (report.files.length === 0) {
    reject("the document filesystem ledger saw nothing at all");
  }
  for (const request of report.files) {
    if (!request.admitted) {
      reject(`${request.operation} of ${request.path} was refused by the ledger`);
    }
  }
  for (const authority of ["net", "write", "run", "sys", "ffi"]) {
    if (report.authorities[authority] !== "denied") {
      reject(`${authority} authority is ${report.authorities[authority]}`);
    }
  }
}

/** Every claim this journey failed, or an empty list when it made them all. */
export function checkJourney(report: ParsedReport): Violation[] {
  const violations: Violation[] = [];
  if (report.dependency.name !== "@bomb.sh/tty" || report.dependency.version !== "0.9.0") {
    violations.push({
      category: "presentation-selection",
      detail: `the record names ${report.dependency.name} ${report.dependency.version}`,
    });
  }
  checkPresentations(report, violations);
  checkOverride(report, violations);
  checkStructuredMarkdown(report, violations);
  checkStableReplacement(report, violations);
  checkCoalescing(report, violations);
  checkHistoryAndNewest(report, violations);
  checkFollowAndUnread(report, violations);
  checkResize(report, violations);
  checkBoundedDiff(report, violations);
  checkForbiddenIntegration(report, violations);
  return violations;
}

/** The categories a set of violations names, in the order the checker found them. */
export function categoriesOf(violations: readonly Violation[]): InvariantCategory[] {
  const seen: InvariantCategory[] = [];
  for (const violation of violations) {
    if (!seen.includes(violation.category)) {
      seen.push(violation.category);
    }
  }
  return seen;
}

/**
 * What differs between the source record and the compiled one.
 *
 * Whole equality, not a spot check: a binary that shipped a different component,
 * lost an embedded asset, or resolved a different dependency answers differently
 * somewhere in the record, and naming the first field that differs is how a
 * reader finds out where.
 */
export function compareRecords(source: unknown, compiled: unknown): string[] {
  const differences: string[] = [];
  walk(source, compiled, "", differences);
  return differences;
}

function walk(left: unknown, right: unknown, path: string, differences: string[]): void {
  const here = path.length === 0 ? "<record>" : path;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      differences.push(`${here}: one side is an array and the other is not`);
      return;
    }
    if (left.length !== right.length) {
      differences.push(`${here}: ${left.length} entries against ${right.length}`);
      return;
    }
    left.forEach((entry, index) => walk(entry, right[index], `${path}[${index}]`, differences));
    return;
  }
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    const names = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const name of [...names].sort()) {
      if (!(name in left) || !(name in right)) {
        differences.push(`${path}.${name}: present on one side only`);
        continue;
      }
      walk(Reflect.get(left, name), Reflect.get(right, name), `${path}.${name}`, differences);
    }
    return;
  }
  if (!Object.is(left, right)) {
    differences.push(`${here}: ${JSON.stringify(left)} against ${JSON.stringify(right)}`);
  }
}

export interface ProductionSurface {
  /** Every production manifest, by path, with its declared dependency names. */
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
  /** Every published export specifier, by manifest path. */
  readonly exports: Readonly<Record<string, readonly string[]>>;
}

/**
 * What a production package would have to have adopted for this proof to have
 * leaked out of `scripts/tests/`.
 *
 * The proof is disposable test infrastructure: no shipped package may depend on
 * the terminal renderer it drives, and no export map may name a module under
 * the proof directory.
 */
export function checkProductionBoundary(surface: ProductionSurface): string[] {
  const leaks: string[] = [];
  for (const [manifest, names] of Object.entries(surface.dependencies)) {
    if (names.includes("@bomb.sh/tty")) {
      leaks.push(`${manifest} depends on @bomb.sh/tty`);
    }
  }
  for (const [manifest, specifiers] of Object.entries(surface.exports)) {
    for (const specifier of specifiers) {
      if (specifier.includes("session-rendering")) {
        leaks.push(`${manifest} exports ${specifier}`);
      }
    }
  }
  return leaks;
}
