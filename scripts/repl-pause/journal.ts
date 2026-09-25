/**
 * The history a paused execution must stop appending to.
 *
 * One journal per session, with each record naming the execution that appended
 * it, because "the target history stops" and "the sibling keeps going" are the
 * same question asked of one ordered log. Two logs could not answer whether a
 * paused subtree slipped a record in between two of the sibling's.
 */

export interface JournalRecord {
  readonly owner: string;
  readonly label: string;
}

export interface Journal {
  /** Append one record and return the journal's new length. */
  append(owner: string, label: string): number;
  /** The whole log's length. */
  readonly head: number;
  /** How many records `owner` has appended — its own history position. */
  headOf(owner: string): number;
  /** The labels `owner` appended, in order. */
  labelsOf(owner: string): readonly string[];
  snapshot(): readonly JournalRecord[];
}

export function createJournal(): Journal {
  const records: JournalRecord[] = [];

  return {
    append(owner, label) {
      records.push({ owner, label });
      return records.length;
    },
    get head() {
      return records.length;
    },
    headOf(owner) {
      return records.filter((record) => record.owner === owner).length;
    },
    labelsOf(owner) {
      return records.filter((record) => record.owner === owner).map((record) => record.label);
    },
    snapshot() {
      return [...records];
    },
  };
}
