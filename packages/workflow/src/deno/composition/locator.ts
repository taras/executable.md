/**
 * Admitting a Git locator, and naming one without publishing it.
 *
 * A locator is ordinary document input: it arrives from a prop or an
 * expression, and nothing about it has been checked. Two questions are asked
 * here and they are different questions. **Admission** decides whether this
 * provider will hand the string to Git at all. **Fingerprinting** produces the
 * stable name the journal, the record and every compatibility comparison use,
 * so a changed locator diverges without the bytes of either one being retained
 * outside the single column that holds them.
 *
 * Admission is a closed allowlist rather than a search for bad shapes. Git's
 * locator grammar reaches well past URLs — `ext::sh -c …` runs a command, a
 * leading `-` is read as an option, and a transport helper is whatever is on
 * `PATH` — so anything not recognized as one of the five admitted forms is
 * refused. Credentials in the string are refused rather than stripped: a
 * locator that carries one is a secret the caller put in a durable input, and
 * quietly editing it would retain a run nobody asked for.
 */

export {
  admitLocator,
  locatorFingerprintOf as locatorFingerprint,
} from "../../composition/locator.ts";
