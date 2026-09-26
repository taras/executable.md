/**
 * What the running process holds and the record does not.
 *
 * Two things live here, and they are here because neither can survive a
 * restart and neither may be written down.
 *
 * **Partial Agent output.** An Agent streams before it has said anything
 * final. Those chunks are how the person watches it think; they are not what
 * happened. Admission is the durable event, and the admitted result is what a
 * record holds — so `admit()` discards the buffer rather than flushing it
 * anywhere. A cold reconstruction shows the admitted result and no partial
 * text, because there is no partial text to show.
 *
 * **Secrets.** A secret is asked for, used, and never kept: not by this module
 * either. `Secrets` is a seam a live process fills and a cold one does not,
 * and the only thing it remembers is *which* waits it was asked about. That
 * list is what the evidence reads, because a list of questions is safe and a
 * list of answers would defeat the whole claim.
 *
 * Nothing here is imported by `journal.ts`, `model.ts`, `project.ts`,
 * `location.ts`, `purity.ts` or `store.ts`, and the evidence reads their
 * imports to say so. Like `overlay.ts`, this is the half of the REPL that
 * process loss is supposed to take.
 */

/** Partial Agent output, per scope, for as long as this process lives. */
export interface Streaming {
  /** What has arrived for one scope and not yet been admitted. */
  partial(scope: string): readonly string[];
  /** One more chunk of output nobody has committed to. */
  receive(scope: string, chunk: string): void;
  /** The result was admitted; the chunks that led to it are not evidence of it. */
  admit(scope: string): void;
  /** Every scope currently mid-stream. */
  streaming(): readonly string[];
}

export function createStreaming(): Streaming {
  const chunks = new Map<string, string[]>();
  return {
    partial(scope) {
      return [...(chunks.get(scope) ?? [])];
    },
    receive(scope, chunk) {
      const held = chunks.get(scope) ?? [];
      held.push(chunk);
      chunks.set(scope, held);
    },
    admit(scope) {
      chunks.delete(scope);
    },
    streaming() {
      return [...chunks.keys()].toSorted();
    },
  };
}

/** A secret, if someone is there to give it. */
export type Revealed = { readonly known: true; readonly value: string } | { readonly known: false };

/**
 * Where a secret comes from, which is always a person and never a record.
 *
 * `asked` is the audit trail: the waits this process had to put in front of
 * someone. It never holds a value, so printing it, logging it or attaching it
 * to an error is safe by construction rather than by care.
 */
export interface Secrets {
  reveal(wait: string, prompt: string): Revealed;
  readonly asked: readonly string[];
}

/** A live process with someone at the keyboard. */
export function scriptedSecrets(answers: Readonly<Record<string, string>>): Secrets {
  const asked: string[] = [];
  return {
    reveal(wait) {
      asked.push(wait);
      const value = answers[wait];
      return value === undefined ? { known: false } : { known: true, value };
    },
    get asked() {
      return [...asked];
    },
  };
}

/**
 * A process with nobody to ask.
 *
 * It still records the question, because reaching a secret frontier with no
 * one there is a thing that happened and the run has to say where it stopped.
 */
export function noSecrets(): Secrets {
  const asked: string[] = [];
  return {
    reveal(wait) {
      asked.push(wait);
      return { known: false };
    },
    get asked() {
      return [...asked];
    },
  };
}
