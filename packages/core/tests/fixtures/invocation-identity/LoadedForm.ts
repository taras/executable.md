/**
 * A repository component that reaches nothing of core's.
 *
 * It imports no module at all, so there is no helper of its own copy for it to
 * ask and no context of its own copy for it to read. The only thing it has is
 * the invocation the engine handed it, which is the point: the authored form
 * travels on that object, so a component evaluated through a separately loaded
 * copy reads the canonical fact by calling what it received.
 */

export const props = { type: "object", properties: {}, additionalProperties: false };

export default function* LoadedForm(
  _props: Record<string, unknown>,
  invocation: { hasContent(): boolean },
): Generator<never, string, never> {
  return `loaded:${invocation.hasContent()}`;
}
