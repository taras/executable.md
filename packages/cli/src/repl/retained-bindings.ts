import type { DurableEvent, Json } from "@executablemd/durable-streams";

type JsonObject = Record<string, Json>;

/** Candidates from the latest root close and the current entry's evaluations. */
export class RetainedBindings {
  private readonly values = new WeakSet<object>();
  private readonly closed = new Map<string, Json>();
  private readonly evaluated = new Map<string, Json>();

  /** Share values without advancing the acknowledged history. */
  share(event: DurableEvent): DurableEvent {
    const field = bindingField(event);
    const { result } = event;
    if (field === undefined || result.status !== "ok" || !jsonObject(result.value)) {
      return event;
    }
    const members = result.value[field];
    if (!jsonObject(members)) {
      return event;
    }

    let shared: JsonObject | undefined;
    for (const [name, value] of Object.entries(members)) {
      if (value === null || typeof value !== "object") {
        continue;
      }
      if (!this.values.has(value)) {
        if (!plainFrozenJson(value)) {
          continue;
        }
        this.values.add(value);
      }
      const closed = this.closed.get(name);
      const evaluated = this.evaluated.get(name);
      const retained = equalJson(value, closed)
        ? closed
        : equalJson(value, evaluated)
          ? evaluated
          : undefined;
      if (retained !== undefined && retained !== value) {
        shared ??= { ...members };
        shared[name] = retained;
      }
    }

    if (shared === undefined) {
      return event;
    }
    return Object.freeze({
      ...event,
      result: Object.freeze({
        ...result,
        value: Object.freeze({ ...result.value, [field]: Object.freeze(shared) }),
      }),
    });
  }

  remember(event: DurableEvent): void {
    const field = bindingField(event);
    if (field === "bindings") {
      this.evaluated.clear();
    }
    const { result } = event;
    if (field === undefined || result.status !== "ok" || !jsonObject(result.value)) {
      return;
    }
    const members = result.value[field];
    if (!jsonObject(members)) {
      return;
    }

    const latest = field === "bindings" ? this.closed : this.evaluated;
    for (const [name, value] of Object.entries(members)) {
      if (value !== null && typeof value === "object" && this.values.has(value)) {
        latest.set(name, value);
      } else {
        latest.delete(name);
      }
    }
  }
}

function bindingField(event: DurableEvent): "bindings" | "value" | undefined {
  if (event.coroutineId !== "root") {
    return undefined;
  }
  if (event.type === "close") {
    return "bindings";
  }
  return event.description.type === "eval" ? "value" : undefined;
}

function jsonObject(value: Json | undefined): value is JsonObject {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

/** Frozen accessors and extra properties cannot stand in for ordinary JSON. */
export function plainFrozenJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || !Object.isFrozen(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1) {
      return false;
    }
    for (let index = 0; index < value.length; index++) {
      const member = Object.getOwnPropertyDescriptor(value, index);
      if (!member?.enumerable || !("value" in member) || !plainFrozenJson(member.value)) {
        return false;
      }
    }
    return true;
  }
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    keys.every((key) => {
      if (typeof key !== "string") {
        return false;
      }
      const member = Object.getOwnPropertyDescriptor(value, key);
      return member?.enumerable === true && "value" in member && plainFrozenJson(member.value);
    })
  );
}

function equalJson(left: Json, right: Json | undefined): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]))
    );
  }
  if (!jsonObject(left) || !jsonObject(right)) {
    return false;
  }
  // Enumerating or serializing an authored object can expose member order.
  const keys = Object.keys(left);
  const previousKeys = Object.keys(right);
  return (
    keys.length === previousKeys.length &&
    keys.every((key, index) => key === previousKeys[index] && equalJson(left[key]!, right[key]))
  );
}
