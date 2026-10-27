/**
 * The one immutable copy of an event that every reader of a retained stream shares.
 *
 * A REPL history can hold the same few megabytes of captured output dozens of
 * times over, because every entry's root close hands on the whole root it
 * inherited. Deep-copying each event for each reader multiplied that by the
 * number of readers, so a history that fit on disk did not fit in a heap. What
 * isolation actually needs is narrower: no reader may change what another one
 * reads. A frozen graph gives that without copying anything a reader cannot
 * change anyway, and JavaScript strings are immutable values, so they are never
 * copied at all.
 *
 * Sealing copies containers, never strings, and freezes the copy. A container
 * that is already frozen and holds only sealed members is reused rather than
 * copied, which is what lets a segment and the physical stream behind it keep
 * one graph between them. A container the caller can still change is copied
 * before anything retains it, so later edits to it reach nothing retained.
 *
 * Execution never receives these objects as values it may change. Core detaches
 * what it replays into fresh mutable data, and the projector detaches what it
 * models; this graph is only what both of them read from.
 */

import type { DurableEvent, EffectDescription, Json, Result } from "@executablemd/durable-streams";

/**
 * Hand back one instance of each equal large string seen while reading a file.
 *
 * Parsing builds a fresh string for every occurrence, so a value repeated in
 * every later root close is held once per close. Equal strings are
 * indistinguishable to every reader, so keeping the first and handing it back
 * for the rest changes nothing anybody can observe.
 */
export type StringSharing = (text: string) => string;

/**
 * Shorter strings are left as they are. Below this, the table's own entry costs
 * about what sharing would save.
 */
const SHARED_LENGTH = 1024;

/**
 * A sharing table for one read, released when the reader drops it.
 *
 * Never module state: a table that outlived its read would keep every large
 * value of every history this process had opened.
 */
export function stringSharing(): StringSharing {
  const held = new Map<string, string>();
  return (text) => {
    if (text.length < SHARED_LENGTH) {
      return text;
    }
    const first = held.get(text);
    if (first !== undefined) {
      return first;
    }
    held.set(text, text);
    return text;
  };
}

/** One event as the immutable graph a retained stream keeps and hands out. */
export function sealEvent(event: DurableEvent, share?: StringSharing): DurableEvent {
  if (event.type === "close") {
    const result = sealResult(event.result, share);
    if (reusable(event) && result === event.result) {
      return event;
    }
    return Object.freeze({ ...event, type: event.type, coroutineId: event.coroutineId, result });
  }
  const description = sealDescription(event.description, share);
  const result = sealResult(event.result, share);
  if (reusable(event) && description === event.description && result === event.result) {
    return event;
  }
  return Object.freeze({
    ...event,
    type: event.type,
    coroutineId: event.coroutineId,
    description,
    result,
  });
}

function sealDescription(
  description: EffectDescription,
  share: StringSharing | undefined,
): EffectDescription {
  // Spread rather than rebuilt, so member order and an own `__proto__` member
  // survive exactly as structured cloning kept them.
  const copy: EffectDescription = {
    ...description,
    type: description.type,
    name: description.name,
  };
  let same = reusable(description);
  for (const [key, member] of Object.entries(copy)) {
    const sealed = sealJson(member, share);
    if (sealed !== member) {
      copy[key] = sealed;
      same = false;
    }
  }
  return same ? description : Object.freeze(copy);
}

function sealResult(result: Result, share: StringSharing | undefined): Result {
  if (result.status === "ok") {
    // Whether `value` is present at all is kept, because an absent value and an
    // undefined one are different records to a reader that asks `in`.
    if (!("value" in result) || result.value === undefined) {
      return reusable(result) ? result : Object.freeze({ ...result });
    }
    const value = sealJson(result.value, share);
    if (reusable(result) && value === result.value) {
      return result;
    }
    return Object.freeze({ ...result, value });
  }
  if (result.status === "err") {
    const error = reusable(result.error) ? result.error : Object.freeze({ ...result.error });
    if (reusable(result) && error === result.error) {
      return result;
    }
    return Object.freeze({ ...result, error });
  }
  return reusable(result) ? result : Object.freeze({ ...result });
}

function sealJson(value: Json, share: StringSharing | undefined): Json {
  if (typeof value === "string") {
    return share === undefined ? value : share(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => sealJson(item, share));
    if (reusable(value) && items.every((item, index) => item === value[index])) {
      return value;
    }
    Object.freeze(items);
    return items;
  }
  const copy = { ...value };
  let same = reusable(value);
  for (const [key, member] of Object.entries(copy)) {
    const sealed = sealJson(member, share);
    if (sealed !== member) {
      copy[key] = sealed;
      same = false;
    }
  }
  return same ? value : Object.freeze(copy);
}

/**
 * Whether this container can be shared as it is.
 *
 * Frozen, and a plain object or array: a class instance can answer its members
 * from accessors, so freezing it says nothing about what it will read as next.
 */
function reusable(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return (
    Object.isFrozen(value) && (prototype === Object.prototype || prototype === Array.prototype)
  );
}
