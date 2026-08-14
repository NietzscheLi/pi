import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import planModeExtension from "../src/extensions/plan-mode/index.ts";
import {
	extractDoneSteps,
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
} from "../src/extensions/plan-mode/utils.ts";

describe("built-in plan mode", () => {
	it("is registered as a hidden built-in extension", () => {
		expect(builtInExtensions).toContainEqual({
			name: "plan-mode",
			factory: planModeExtension,
			hidden: true,
		});
	});

	it("registers its commands, shortcut, and startup flag", async () => {
		const extension = await loadExtensionFromFactory(
			planModeExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:plan-mode>",
		);

		expect(extension.commands.get("plan")?.description).toBe("Toggle plan mode (read-only exploration)");
		expect(extension.commands.get("todos")?.description).toBe("Show current plan todo list");
		expect(extension.flags.get("plan")).toEqual(expect.objectContaining({ type: "boolean", default: false }));
		expect(extension.shortcuts.size).toBe(1);
	});

	it("allows inspection commands and blocks mutation commands", () => {
		expect(isSafeCommand("git diff -- src/index.ts")).toBe(true);
		expect(isSafeCommand("rg -n plan src")).toBe(true);
		expect(isSafeCommand("npm install package")).toBe(false);
		expect(isSafeCommand("git status && rm file")).toBe(false);
		expect(isSafeCommand("node script.js")).toBe(false);
	});

	it("extracts numbered plan steps and completion markers", () => {
		const todos = extractTodoItems(`Plan:\n1. Read the current implementation\n2. Update the relevant tests`);
		expect(todos).toEqual([
			{ step: 1, text: "Current implementation", completed: false },
			{ step: 2, text: "Relevant tests", completed: false },
		]);
		expect(extractDoneSteps("Finished [DONE:1] and [done:2]")).toEqual([1, 2]);
		expect(markCompletedSteps("[DONE:2]", todos)).toBe(1);
		expect(todos[1]?.completed).toBe(true);
	});
});
