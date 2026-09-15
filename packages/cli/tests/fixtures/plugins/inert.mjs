// Never selected by any row. Its presence beside the fixtures that are
// selected is what makes "an unselected module does nothing" observable: if
// anything discovered it, this line would be in the output.
console.error("inert-fixture: this module should never be loaded");

export default { name: "inert-fixture" };
