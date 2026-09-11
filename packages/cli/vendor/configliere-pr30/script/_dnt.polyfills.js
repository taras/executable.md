"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// https://github.com/tc39/proposal-accessible-object-hasownproperty/blob/main/polyfill.js
if (!Object.hasOwn) {
    Object.defineProperty(Object, "hasOwn", {
        value: function (object, property) {
            if (object == null) {
                throw new TypeError("Cannot convert undefined or null to object");
            }
            return Object.prototype.hasOwnProperty.call(Object(object), property);
        },
        configurable: true,
        enumerable: false,
        writable: true,
    });
}
/**
 * String.prototype.replaceAll() polyfill
 * https://gomakethings.com/how-to-replace-a-section-of-a-string-with-another-one-with-vanilla-js/
 * @author Chris Ferdinandi
 * @license MIT
 */
if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function (str, newStr) {
        // If a regex pattern
        if (Object.prototype.toString.call(str).toLowerCase() === "[object regexp]") {
            return this.replace(str, newStr);
        }
        // If a string
        return this.replace(new RegExp(str, "g"), newStr);
    };
}
//# sourceMappingURL=_dnt.polyfills.js.map