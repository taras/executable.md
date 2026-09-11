import { dynamic } from "./dynamic.js";
import { withValues } from "./values.js";
export function checkpoint() {
    return dynamic((values) => withValues(values));
}
//# sourceMappingURL=checkpoint.js.map