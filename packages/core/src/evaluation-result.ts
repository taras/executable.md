import type { GeneratedObservationResult, GeneratedObservationValue } from "./generated-xmd.ts";
import type { Json } from "./types.ts";
import { parseJson } from "./json.ts";
import { EvaluationInfrastructureError, EvaluationLimitError } from "./evaluation-errors.ts";

/** Bounds belong to the surrounding operation, not the evaluation profile. */
export interface EvaluationBounds {
  readonly durationMs: number;
  readonly resultBytes: number;
}

/** The complete-result wire spelling, including lexically sorted nested keys. */
export function encodeEvaluationResult(result: GeneratedObservationResult): string {
  return `{"observations":[${result.observations
    .map(
      (observation) =>
        `{"name":${JSON.stringify(observation.name)},"value":${encodeValue(observation.value)}}`,
    )
    .join(",")}],"output":${JSON.stringify(result.output)}}`;
}

function encodeValue(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(encodeValue).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encodeValue(value[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function captureEvaluationBounds(input: EvaluationBounds): EvaluationBounds {
  try {
    if (
      !Object.isFrozen(input) ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      Reflect.ownKeys(input).sort().join(",") !== "durationMs,resultBytes"
    ) {
      throw new Error("Bounds must be an immutable closed record.");
    }
    const duration = Object.getOwnPropertyDescriptor(input, "durationMs");
    const bytes = Object.getOwnPropertyDescriptor(input, "resultBytes");
    const durationMs: unknown = duration?.value;
    const resultBytes: unknown = bytes?.value;
    if (
      duration?.get !== undefined ||
      bytes?.get !== undefined ||
      typeof durationMs !== "number" ||
      !Number.isSafeInteger(durationMs) ||
      durationMs <= 0 ||
      typeof resultBytes !== "number" ||
      !Number.isSafeInteger(resultBytes) ||
      resultBytes < 0
    ) {
      throw new Error(
        "Bounds require a positive safe integer duration and a nonnegative byte ceiling.",
      );
    }
    return Object.freeze({ durationMs, resultBytes });
  } catch (cause) {
    throw new EvaluationInfrastructureError("setup", cause);
  }
}

/** Account before retaining each chunk or native provider value. */
export class EvaluationResultCapture {
  #bytes = 31;
  #observations: GeneratedObservationValue[] = [];
  #output: string[] = [];
  #pending = "";
  #open = true;
  #failure: EvaluationLimitError | undefined;

  constructor(
    readonly ceiling: number,
    readonly enclosing?: EvaluationResultCapture,
  ) {}

  get failure(): EvaluationLimitError | undefined {
    return this.#failure;
  }

  start(): void {
    this.#charge(0);
  }

  #charge(bytes: number): void {
    if (!this.#open) {
      throw new EvaluationInfrastructureError(
        "runtime",
        new Error("The result capture is closed."),
      );
    }
    this.#bytes += bytes;
    if (this.#bytes > this.ceiling) {
      this.#failure = new EvaluationLimitError("result-bytes");
      this.close();
      throw this.#failure;
    }
  }

  #string(value: string): void {
    for (const char of value) {
      const point = char.codePointAt(0)!;
      this.#charge(
        point > 0xffff
          ? 4
          : point >= 0xd800 && point <= 0xdfff
            ? 6
            : point === 34 || point === 92 || [8, 9, 10, 12, 13].includes(point)
              ? 2
              : point < 32
                ? 6
                : point < 128
                  ? 1
                  : point < 2048
                    ? 2
                    : 3,
      );
    }
  }

  #value(value: Json): void {
    if (typeof value === "string") {
      this.#charge(2);
      this.#string(value);
    } else if (Array.isArray(value)) {
      this.#charge(2);
      for (let index = 0; index < value.length; index++) {
        this.#charge(index === 0 ? 0 : 1);
        this.#value(value[index]!);
      }
    } else if (value !== null && typeof value === "object") {
      this.#charge(2);
      const keys = Object.keys(value).sort();
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!;
        this.#charge(index === 0 ? 3 : 4);
        this.#string(key);
        this.#value(value[key]!);
      }
    } else {
      this.#charge(JSON.stringify(value).length);
    }
  }

  observation(observation: GeneratedObservationValue): void {
    this.#charge(this.#observations.length === 0 ? 20 : 21);
    this.#string(observation.name);
    this.#value(observation.value);
    this.enclosing?.observation(observation);
    this.#observations.push(observation);
  }

  output(chunk: string): void {
    this.enclosing?.output(chunk);
    if (this.#pending !== "") {
      this.#charge(-4);
    }
    const text = this.#pending + chunk;
    const last = text.charCodeAt(text.length - 1);
    this.#pending = last >= 0xd800 && last <= 0xdbff ? text.slice(-1) : "";
    const accepted = this.#pending === "" ? text : text.slice(0, -1);
    this.#string(accepted);
    // A trailing high surrogate needs at least four encoded bytes even if
    // the next chunk completes it; an unpaired one ultimately needs six.
    if (this.#pending !== "") {
      this.#charge(4);
    }
    this.#output.push(accepted);
  }

  result(): GeneratedObservationResult {
    this.#charge(0);
    if (this.#pending !== "") {
      this.#charge(-4);
    }
    this.#string(this.#pending);
    this.#output.push(this.#pending);
    this.#pending = "";
    return {
      observations: this.#observations.map(({ name, value }) => ({
        name,
        value: parseJson(value),
      })),
      output: this.#output.join(""),
    };
  }

  close(): void {
    this.#open = false;
    this.#observations.length = 0;
    this.#output.length = 0;
    this.#pending = "";
  }
}
