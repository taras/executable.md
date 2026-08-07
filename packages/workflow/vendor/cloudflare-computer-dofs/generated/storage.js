export class Database {
    sql;
    transactionSync;
    // Depth counter so reentrant transactionSync() calls work. The
    // outer call uses the storage adapter's transactionSync (or
    // BEGIN/COMMIT under the hood); nested calls use SAVEPOINTs
    // through sql.exec directly. SQLite forbids a real BEGIN inside
    // an active transaction.
    #txDepth = 0;
    constructor(storage) {
        this.sql = storage.sql;
        this.transactionSync = (closure) => {
            if (this.#txDepth > 0) {
                // Reentrant call: use a savepoint. SQLite's RELEASE on a
                // savepoint inside an outer transaction commits the inner
                // work without ending the outer one.
                const sp = `_t${this.#txDepth}`;
                this.sql.exec(`SAVEPOINT ${sp}`);
                this.#txDepth++;
                try {
                    const result = closure();
                    this.sql.exec(`RELEASE ${sp}`);
                    return result;
                }
                catch (error) {
                    this.sql.exec(`ROLLBACK TO ${sp}`);
                    this.sql.exec(`RELEASE ${sp}`);
                    throw error;
                }
                finally {
                    this.#txDepth--;
                }
            }
            // Outer call: hand off to the storage adapter so the DO
            // runtime's transaction semantics apply.
            this.#txDepth++;
            try {
                if (storage.transactionSync !== undefined) {
                    return storage.transactionSync(closure);
                }
                if (storage.transaction !== undefined) {
                    const result = storage.transaction(closure);
                    if (result !== undefined &&
                        result !== null &&
                        typeof result === "object" &&
                        "then" in result) {
                        throw new Error("Durable Object storage adapter requires synchronous transactions");
                    }
                    return result;
                }
                return closure();
            }
            finally {
                this.#txDepth--;
            }
        };
    }
    // True while a transactionSync closure is on the stack. The resolve
    // cache uses this to refuse populating entries mid-transaction, so a
    // rolled-back mutation can never leave the cache reflecting
    // uncommitted state. (Invalidation still runs freely inside a
    // transaction — dropping an entry is always safe.)
    //
    // Invariant: #txDepth only tracks transactionSync. A raw
    // BEGIN/SAVEPOINT issued through run() would open a transaction this
    // flag can't see, letting the cache populate mid-transaction and
    // survive a rollback — so transactionSync is the only sanctioned way
    // to open one.
    get inTransaction() {
        return this.#txDepth > 0;
    }
    run(query, ...bindings) {
        this.sql.exec(query, ...bindings);
    }
    all(query, ...bindings) {
        const rows = this.sql.exec(query, ...bindings).toArray();
        return rows.map((row) => normalizeRow(row));
    }
    one(query, ...bindings) {
        return this.all(query, ...bindings)[0];
    }
    scalar(query, ...bindings) {
        const row = this.one(query, ...bindings);
        if (row === undefined) {
            return undefined;
        }
        const [value] = Object.values(row);
        return value;
    }
}
// Cloudflare's DO SqlStorage returns BLOB columns as ArrayBuffer,
// whereas node:sqlite returns Uint8Array. Normalise to Uint8Array so
// the rest of the code only has to handle one shape.
function normalizeRow(row) {
    // node:sqlite hands back rows with a null prototype; the DO SQL
    // flavour returns ArrayBuffer for BLOB columns. Re-key into a plain
    // {} so consumers get Object.prototype-shaped rows (capnweb's
    // serializer keys off Object.prototype to detect "object") and
    // convert any ArrayBuffer to Uint8Array in the same pass.
    const out = {};
    for (const key of Object.keys(row)) {
        const value = row[key];
        out[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    }
    return out;
}
