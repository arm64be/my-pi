import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { type ClientBindingRequest, ClientBindings } from "../../src/core/client-bindings.ts";
import { createHarness, getToolResult } from "./harness.ts";

it("routes commands, tools and hooks through the originating client with the current session API", async () => {
	const bindings = new ClientBindings();
	const notify = {
		id: "ui.notify",
		version: 1,
		input: Type.Object({ message: Type.String() }),
		output: Type.Object({ displayed: Type.Boolean() }),
	};
	const received: Array<{ client: string; request: ClientBindingRequest }> = [];
	const terminal = bindings.connect("terminal", [notify], async (request) => {
		received.push({ client: "terminal", request });
		return { displayed: true };
	});
	const browser = bindings.connect("browser", [notify], async (request) => {
		received.push({ client: "browser", request });
		return { displayed: true };
	});
	const harness = await createHarness({
		tools: [],
		extensionFactories: [
			(pi) => {
				pi.registerCommand("notify", {
					description: "Notify the client",
					handler: async (message) => {
						await bindings.invoke(notify, { message });
					},
				});
				pi.registerTool({
					name: "notify",
					label: "Notify",
					description: "Notify the originating client",
					parameters: notify.input,
					async execute(_id, input, signal) {
						const result = await bindings.invoke(notify, input, { signal });
						return { content: [{ type: "text", text: "Displayed" }], details: result };
					},
				});
				pi.on("message_end", async (event) => {
					if (event.message.role === "assistant" && event.message.stopReason === "stop") {
						await bindings.invoke(notify, { message: "hook" });
					}
				});
			},
		],
	});
	try {
		await terminal.run(() => harness.session.prompt("/notify command"));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("notify", { message: "tool" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		await browser.run(() => harness.session.prompt("Notify me"));
		expect(getToolResult(harness, "notify").isError).toBe(false);
		expect(received.map(({ client, request }) => ({ client, input: request.input }))).toEqual([
			{ client: "terminal", input: { message: "command" } },
			{ client: "browser", input: { message: "tool" } },
			{ client: "browser", input: { message: "hook" } },
		]);
	} finally {
		harness.cleanup();
		bindings.dispose();
	}
});
