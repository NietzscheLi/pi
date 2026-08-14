import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import planModeExtension from "./plan-mode/index.ts";
import statusFooterExtension from "./status-footer.ts";

export { createPresetExtension } from "./preset.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "plan-mode", factory: planModeExtension, hidden: true },
	{ name: "status-footer", factory: statusFooterExtension, hidden: true },
];
