import { describe, expect, it } from "vitest";
import { OAuthCallbackServer } from "../src/oauth/callback.ts";

describe("OAuth continuation callback", () => {
	it("waits for the continuation upload before redirecting the browser", async () => {
		const server = await OAuthCallbackServer.listen();
		try {
			const callback = server.waitForCallback("state", "/callback", { deferResponse: true });
			const response = fetch(`${server.redirectUrl}?state=state&code=code`, { redirect: "manual" });
			const authorization = await callback;
			expect(authorization.code).toBe("code");
			expect(authorization.respond?.({ redirectUrl: "https://example.com/complete" })).toBe(true);
			expect(authorization.respond?.({ ok: true })).toBe(false);
			const result = await response;
			expect(result.status).toBe(302);
			expect(result.headers.get("location")).toBe("https://example.com/complete");
			expect(result.headers.get("cache-control")).toBe("no-store");
			await result.text();
		} finally {
			await server.close();
		}
	});

	it("reports a failed continuation to the waiting browser", async () => {
		const server = await OAuthCallbackServer.listen();
		try {
			const callback = server.waitForCallback("state", "/callback", { deferResponse: true });
			const response = fetch(`${server.redirectUrl}?state=state&code=code`);
			const authorization = await callback;
			expect(authorization.respond?.({ ok: false, message: "Continuation upload failed" })).toBe(true);
			const result = await response;
			expect(result.status).toBe(500);
			expect(await result.text()).toBe("Continuation upload failed");
		} finally {
			await server.close();
		}
	});
});
