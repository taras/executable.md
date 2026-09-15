// A different module carrying the Plugin name `wrapper-one` already uses. Two
// selections claiming one Plugin name are refused before either installs.
import { Plugin } from "@executablemd/core/api";

export default Plugin({ name: "wrapper-one" });
