/** Run two local client callbacks through one session, without making model requests. */
import {
	ClientBindings,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const bindings = new ClientBindings();
const notify = {
	id: "ui.notify",
	version: 1,
	input: Type.Object({ message: Type.String({ minLength: 1 }) }),
	output: Type.Object({ displayed: Type.Boolean() }),
};
const settingsManager = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	settingsManager,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	agentsFilesOverride: () => ({ agentsFiles: [] }),
	extensionFactories: [
		(pi) => {
			pi.registerCommand("notify", {
				description: "Notify the originating client",
				handler: async (message) => {
					await bindings.invoke(notify, { message });
				},
			});
		},
	],
});
await loader.reload();
const { session } = await createAgentSession({
	resourceLoader: loader,
	settingsManager,
	sessionManager: SessionManager.inMemory(),
	tools: [],
});

try {
	for (const id of ["terminal", "browser"]) {
		const client = bindings.connect(id, [notify], async (request) => {
			console.log(`${id} received ${request.id}: ${JSON.stringify(request.input)}`);
			return { displayed: true };
		});
		await client.run(() => session.prompt(`/notify Hello ${id}`));
		client.disconnect();
	}
} finally {
	session.dispose();
	bindings.dispose();
}
