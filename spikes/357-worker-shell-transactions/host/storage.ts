import { DatabaseSync, type StatementSync } from "node:sqlite";
// @ts-types="../../351-worker-backends/host/types/dofs.d.ts"
import type { DurableObjectStorageLike, SQLCursorLike } from "@cloudflare/dofs";

class Cursor<Row extends object> implements SQLCursorLike<Row> {
  #rows: Row[];

  constructor(rows: Row[]) {
    this.#rows = rows;
  }

  toArray(): Row[] {
    return this.#rows;
  }
}

export interface JournalEntry {
  effectId: string;
  status: "ok" | "failed";
  payload: string;
}

export interface TransactionMetrics {
  nestedDofsTransactions: number;
  effectTransactionsBegun: number;
  effectCommits: number;
  effectRollbacks: number;
  journalAppendsInEffect: number;
}

export class FileSQLiteStorage implements DurableObjectStorageLike {
  #db: DatabaseSync;
  #cache = new Map<string, StatementSync>();
  #effect: EffectTransaction | undefined;
  #savepointSequence = 0;
  #nestedDofsTransactions = 0;
  #effectTransactionsBegun = 0;
  #effectCommits = 0;
  #effectRollbacks = 0;
  #journalAppendsInEffect = 0;
  readonly sql: {
    exec: <Row extends object>(
      query: string,
      ...bindings: unknown[]
    ) => SQLCursorLike<Row>;
  };

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.sql = {
      exec: <Row extends object>(query: string, ...bindings: unknown[]) => {
        let statement = this.#cache.get(query);
        if (statement === undefined) {
          statement = this.#db.prepare(query);
          this.#cache.set(query, statement);
        }
        const rows: Row[] = [];
        for (const row of statement.all(...bindings.map(toSQLiteValue))) {
          if (isRow<Row>(row)) {
            rows.push(row);
          }
        }
        return new Cursor(rows);
      },
    };
  }

  initializeJournal(): void {
    this.#db.exec(`CREATE TABLE IF NOT EXISTS effect_journal (
      effect_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
      payload TEXT NOT NULL
    )`);
  }

  transactionSync<T>(closure: () => T): T {
    if (this.#effect?.active === true) {
      const savepoint = `_dofs_${++this.#savepointSequence}`;
      this.#nestedDofsTransactions++;
      this.#db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const value = closure();
        this.#db.exec(`RELEASE ${savepoint}`);
        return value;
      } catch (error) {
        this.#db.exec(`ROLLBACK TO ${savepoint}`);
        this.#db.exec(`RELEASE ${savepoint}`);
        throw error;
      }
    }

    this.#db.exec("BEGIN");
    try {
      const value = closure();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  beginEffect(effectId: string): EffectTransaction {
    if (this.#effect?.active === true) {
      throw new Error(
        `effect transaction ${this.#effect.effectId} is already active`,
      );
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#db.exec("SAVEPOINT shell_mutations");
    this.#effectTransactionsBegun++;
    const transaction = new EffectTransaction(this, effectId);
    this.#effect = transaction;
    return transaction;
  }

  readJournal(effectId: string): JournalEntry | undefined {
    const row = this.#db.prepare(
      "SELECT effect_id, status, payload FROM effect_journal WHERE effect_id = ?",
    ).get(effectId);
    return parseJournalEntry(row);
  }

  metrics(): TransactionMetrics {
    return {
      nestedDofsTransactions: this.#nestedDofsTransactions,
      effectTransactionsBegun: this.#effectTransactionsBegun,
      effectCommits: this.#effectCommits,
      effectRollbacks: this.#effectRollbacks,
      journalAppendsInEffect: this.#journalAppendsInEffect,
    };
  }

  releaseMutations(transaction: EffectTransaction): void {
    this.#assertOwner(transaction);
    this.#db.exec("RELEASE shell_mutations");
  }

  rollbackMutations(transaction: EffectTransaction): void {
    this.#assertOwner(transaction);
    this.#db.exec("ROLLBACK TO shell_mutations");
    this.#db.exec("RELEASE shell_mutations");
  }

  appendJournal(
    transaction: EffectTransaction,
    status: JournalEntry["status"],
    payload: string,
  ): void {
    this.#assertOwner(transaction);
    this.#db.prepare(
      "INSERT INTO effect_journal (effect_id, status, payload) VALUES (?, ?, ?)",
    ).run(transaction.effectId, status, payload);
    this.#journalAppendsInEffect++;
  }

  commit(transaction: EffectTransaction): void {
    this.#assertOwner(transaction);
    this.#db.exec("COMMIT");
    this.#effectCommits++;
    this.#effect = undefined;
  }

  rollback(transaction: EffectTransaction): void {
    this.#assertOwner(transaction);
    this.#db.exec("ROLLBACK");
    this.#effectRollbacks++;
    this.#effect = undefined;
  }

  close(): void {
    if (this.#effect?.active === true) {
      this.#effect.abort();
    }
    this.#cache.clear();
    this.#db.close();
  }

  #assertOwner(transaction: EffectTransaction): void {
    if (this.#effect !== transaction || !transaction.active) {
      throw new Error(
        `effect transaction ${transaction.effectId} is not active`,
      );
    }
  }
}

export class EffectTransaction {
  #storage: FileSQLiteStorage;
  #state: "mutating" | "publishing" | "committed" | "aborted" = "mutating";
  readonly effectId: string;

  constructor(storage: FileSQLiteStorage, effectId: string) {
    this.#storage = storage;
    this.effectId = effectId;
  }

  get active(): boolean {
    return this.#state === "mutating" || this.#state === "publishing";
  }

  assertMutationOwner(effectId: string): void {
    if (effectId !== this.effectId) {
      throw new Error(
        `foreign effect identity ${effectId}; active effect is ${this.effectId}`,
      );
    }
    if (this.#state !== "mutating") {
      throw new Error(
        `effect transaction ${effectId} no longer accepts mutations`,
      );
    }
  }

  acceptMutations(): void {
    this.#assertState("mutating");
    this.#storage.releaseMutations(this);
    this.#state = "publishing";
  }

  discardMutations(): void {
    this.#assertState("mutating");
    this.#storage.rollbackMutations(this);
    this.#state = "publishing";
  }

  appendResult(status: JournalEntry["status"], payload: string): void {
    this.#assertState("publishing");
    this.#storage.appendJournal(this, status, payload);
  }

  commit(): void {
    this.#assertState("publishing");
    this.#storage.commit(this);
    this.#state = "committed";
  }

  abort(): void {
    if (!this.active) {
      return;
    }
    this.#storage.rollback(this);
    this.#state = "aborted";
  }

  #assertState(expected: "mutating" | "publishing"): void {
    if (this.#state !== expected) {
      throw new Error(
        `effect transaction ${this.effectId} is ${this.#state}, expected ${expected}`,
      );
    }
  }
}

type SQLiteValue = null | number | bigint | string | Uint8Array;

function toSQLiteValue(value: unknown): SQLiteValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  throw new TypeError(`cannot bind value of type ${typeof value}`);
}

function isRow<Row extends object>(value: unknown): value is Row {
  return typeof value === "object" && value !== null;
}

function parseJournalEntry(value: unknown): JournalEntry | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (!("effect_id" in value) || typeof value.effect_id !== "string") {
    return undefined;
  }
  if (
    !("status" in value) ||
    (value.status !== "ok" && value.status !== "failed")
  ) {
    return undefined;
  }
  if (!("payload" in value) || typeof value.payload !== "string") {
    return undefined;
  }
  return {
    effectId: value.effect_id,
    status: value.status,
    payload: value.payload,
  };
}
