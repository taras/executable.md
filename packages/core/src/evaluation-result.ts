import type { Segment } from "./types.ts";
import { renderSegments } from "./render.ts";
import { EvaluationInfrastructureError, EvaluationLimitError } from "./evaluation-errors.ts";

export interface EvaluationBounds {
  readonly durationMs: number;
  readonly outputBytes: number;
}

export function captureEvaluationBounds(input: EvaluationBounds): EvaluationBounds {
  try {
    if (
      !Object.isFrozen(input) ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      Reflect.ownKeys(input).sort().join(",") !== "durationMs,outputBytes"
    ) {
      throw new Error("Bounds must be an immutable closed record.");
    }
    const duration = Object.getOwnPropertyDescriptor(input, "durationMs");
    const bytes = Object.getOwnPropertyDescriptor(input, "outputBytes");
    const durationMs: unknown = duration?.value;
    const outputBytes: unknown = bytes?.value;
    if (
      typeof durationMs !== "number" ||
      !Number.isSafeInteger(durationMs) ||
      durationMs <= 0 ||
      typeof outputBytes !== "number" ||
      !Number.isSafeInteger(outputBytes) ||
      outputBytes < 0
    ) {
      throw new Error(
        "Bounds require a positive safe integer duration and a nonnegative byte ceiling.",
      );
    }
    return Object.freeze({ durationMs, outputBytes });
  } catch (cause) {
    throw new EvaluationInfrastructureError("setup", cause);
  }
}

export class EvaluationOutputCapture {
  #bytes = 0;
  #output: string[] = [];
  #pending = "";
  #open = true;

  constructor(
    readonly ceiling: number,
    readonly enclosing?: EvaluationOutputCapture,
  ) {}

  #check(bytes: number): void {
    if (!this.#open) {
      throw new EvaluationInfrastructureError(
        "runtime",
        new Error("The output capture is closed."),
      );
    }
    if (this.#bytes + bytes > this.ceiling) {
      throw new EvaluationLimitError("output-bytes");
    }
    if (this.enclosing !== undefined) {
      this.enclosing.#check(this.#bytes + bytes);
    }
  }

  output(chunk: string): void {
    const text = this.#pending + chunk;
    const last = text.charCodeAt(text.length - 1);
    const pending = last >= 0xd800 && last <= 0xdbff ? text.slice(-1) : "";
    const accepted = pending === "" ? text : text.slice(0, -1);
    const bytes = new TextEncoder().encode(text).length - (this.#pending === "" ? 0 : 3);
    this.#check(bytes);
    this.#bytes += bytes;
    this.#pending = pending;
    this.#output.push(accepted);
  }

  /** A renderer checks chunks before its complete string reaches the owning projection. */
  meter(): EvaluationOutputCapture {
    return new EvaluationOutputCapture(this.ceiling - this.#bytes, this);
  }

  segments(): Segment[] {
    const capture = this;
    return new (class extends Array<Segment> {
      override push(...segments: Segment[]): number {
        capture.output(renderSegments(segments));
        return super.push(...segments);
      }
    })();
  }

  result(): string {
    this.#check(0);
    return this.#output.join("") + this.#pending;
  }

  close(): void {
    this.#open = false;
    this.#output.length = 0;
    this.#pending = "";
  }
}
