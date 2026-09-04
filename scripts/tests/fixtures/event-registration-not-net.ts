/** A `connect` that is not the one `node:net` exports. */
export function connect(_url: string) {
  return {
    on(_event: string, _handler: () => void) {},
    once(_event: string, _handler: () => void) {},
  };
}
