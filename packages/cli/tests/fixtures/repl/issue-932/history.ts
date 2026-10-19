/**
 * What the saved-failure fixture was produced from, and what it therefore says.
 *
 * The producer sends these prompts and scripts these replies; the rows that
 * read the fixture assert against these same strings. Keeping both ends here
 * is what makes an assertion about the file an assertion about something a run
 * genuinely retained, rather than about a literal copied into a test.
 *
 * Every string is written for this fixture. The astral characters are
 * deliberate: a window counted in UTF-16 units would cut one in half, and the
 * row that catches it needs a saved text with one in it.
 */

/** The agent turns the eight completed prompts streamed, in order. */
export const PROMPT_REPLIES: readonly string[] = [
  "Watch one is set: the harbour lamp 🜂 burns until the tide turns.",
  "Watch two is set: the stone quay 𐤀 is counted and clear.",
  "Watch three is set: the long pier holds two boats and a rope.",
  "Watch four is set: the ferry 🜁 is moored and nobody is aboard.",
  "Watch five is set: the salt house is locked and the key is hung.",
  "Watch six is set: the north gate 𐤁 is open to the market alone.",
  "Watch seven is set: the bell rope is whole and the bell is quiet.",
  "Watch eight is set: the daylight register 🜃 is signed and filed.",
];

/**
 * The ninth turn's reply: a complete, parseable ballot, from a turn that failed.
 *
 * Long enough that a small window pages it, and astral in the middle of that
 * paging, so a reader following `next` has to carry a whole character across
 * the boundary.
 */
export const BALLOT_REPLY = JSON.stringify(
  {
    charter: "open_watch",
    work: "boats",
    plan:
      "I keep my vote where it was: daylight 🜂 and two watchers, since a stone " +
      "that only one person has looked at 𐤀 is a stone nobody has counted.",
    watchers: ["Mara", "Lin"],
  },
  null,
  2,
);

/**
 * The stop reason the ninth turn settles with.
 *
 * Anything but `end_turn` is a turn the provider reports as failed while
 * keeping whatever it streamed, which is exactly the saved shape this fixture
 * exists to hold: valid returned text, and execution that did not succeed.
 */
export const STOP_REASON = "refusal";

/** The eight requests that complete, in the order the entry writes them. */
export const PROMPT_REQUESTS: readonly string[] = PROMPT_REPLIES.map(
  (_reply, index) => `Set watch ${index + 1} of the harbour ballot 🜂 and say so.`,
);

/** The ninth request, which is the one a reader of the failure goes looking for. */
export const BALLOT_REQUEST =
  "Cast the ninth ballot 𐤀 for the open watch: answer with the charter, the " +
  "work, the plan and the watchers, as one JSON object and nothing else.";

/**
 * The entry that fails with nothing printed.
 *
 * Every prompt captures its reply, so the entry renders nothing at all; the
 * ninth stops the document with `throwOnError`, which is what makes the entry
 * itself a failure rather than a run that carried on past one. A reader of
 * this entry's output alone learns nothing, which is the situation the four
 * reads exist for.
 */
export const FAILED_ENTRY = [
  ...PROMPT_REQUESTS.map((request, index) => `<Prompt text="${request}" as="watch${index + 1}" />`),
  `<Prompt text="${BALLOT_REQUEST}" as="ballot" throwOnError={true} />`,
  "",
].join("\n");

/** A later entry that settles, so the latest entry is not the failed one. */
export const SETTLED_ENTRY = "The harbour register 🜃 is closed for the night.\n";

/**
 * What the failed entry's serialized stack says in the checked-in bytes.
 *
 * A thrown failure is retained with the stack of the process that raised it,
 * and that stack names the producing checkout's absolute paths. Nothing reads
 * it — a failed outcome's reason is its message alone — so the producer puts
 * this sentence there instead and the receipt says so.
 */
export const SUBSTITUTED_STACK =
  "the producing machine's stack is not part of this fixture; see RECEIPT.md";
