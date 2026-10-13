import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientBindings, type ClientBindingTransport } from "../src/core/client-bindings.ts";

const notify = {
	id: "ui.notify",
	version: 1,
	input: Type.Object({ message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	output: Type.Object({ displayed: Type.Boolean() }, { additionalProperties: false }),
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("ClientBindings", () => {
	const bindings = new ClientBindings();
	afterEach(() => {
		bindings.dispose();
		vi.useRealTimers();
	});

	it("keeps concurrent operations attached to their originating connections", async () => {
		const firstStarted = deferred<void>();
		const releaseFirst = deferred<void>();
		const received: string[] = [];
		const requestIds = new Set<string>();
		const transport =
			(id: string): ClientBindingTransport =>
			async (request) => {
				received.push(`${id}:${JSON.stringify(request.input)}`);
				requestIds.add(request.requestId);
				return { displayed: true };
			};
		const first = bindings.connect("first", [notify], transport("first"));
		const second = bindings.connect("second", [notify], transport("second"));
		const pending = first.run(async () => {
			firstStarted.resolve();
			await releaseFirst.promise;
			expect(bindings.has(notify)).toBe(true);
			return bindings.invoke(notify, { message: "first" });
		});
		await firstStarted.promise;
		await second.run(() => bindings.invoke(notify, { message: "second" }));
		releaseFirst.resolve();
		await expect(pending).resolves.toEqual({ displayed: true });
		expect(received).toEqual(['second:{"message":"second"}', 'first:{"message":"first"}']);
		expect(requestIds.size).toBe(2);
		expect(bindings.has(notify)).toBe(false);
		await expect(bindings.invoke(notify, { message: "no origin" })).rejects.toMatchObject({
			code: "client_unavailable",
		});
	});

	it("negotiates versions and validates both sides of the call", async () => {
		let calls = 0;
		const client = bindings.connect("client", [notify], async () => {
			calls++;
			return { displayed: "wrong" };
		});
		await client.run(async () => {
			expect(bindings.has({ ...notify, version: 2 })).toBe(false);
			await expect(bindings.invoke({ ...notify, version: 2 }, { message: "ok" })).rejects.toMatchObject({
				code: "binding_unavailable",
			});
			await expect(bindings.invoke(notify, { message: "" })).rejects.toMatchObject({ code: "invalid_input" });
			expect(calls).toBe(0);
			await expect(bindings.invoke(notify, { message: "ok" })).rejects.toMatchObject({ code: "invalid_output" });
		});
		expect(calls).toBe(1);
	});

	it("cancels pending calls on disconnect and cannot reuse an old connection after reconnect", async () => {
		const started = deferred<AbortSignal>();
		const reply = deferred<unknown>();
		const old = bindings.connect("client", [notify], async (_request, signal) => {
			started.resolve(signal);
			return reply.promise;
		});
		const pending = old.run(() => bindings.invoke(notify, { message: "old" }));
		const rejected = expect(pending).rejects.toMatchObject({ code: "client_unavailable" });
		const signal = await started.promise;
		old.disconnect();
		await rejected;
		expect(signal.aborted).toBe(true);
		const current = bindings.connect("client", [notify], async () => ({ displayed: true }));
		old.disconnect();
		reply.resolve({ displayed: false });
		await expect(old.run(() => bindings.invoke(notify, { message: "stale" }))).rejects.toMatchObject({
			code: "client_unavailable",
		});
		await expect(current.run(() => bindings.invoke(notify, { message: "new" }))).resolves.toEqual({
			displayed: true,
		});
	});

	it("bounds calls with a timeout and passes cancellation to the transport", async () => {
		vi.useFakeTimers();
		const started = deferred<AbortSignal>();
		const client = bindings.connect("client", [notify], async (_request, signal) => {
			started.resolve(signal);
			return new Promise(() => {});
		});
		const pending = client.run(() => bindings.invoke(notify, { message: "wait" }, { timeoutMs: 20 }));
		const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
		const signal = await started.promise;
		await vi.advanceTimersByTimeAsync(20);
		await rejected;
		expect(signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("handles abort before dispatch and during a call", async () => {
		let calls = 0;
		const started = deferred<AbortSignal>();
		const client = bindings.connect("client", [notify], async (_request, signal) => {
			calls++;
			started.resolve(signal);
			return new Promise(() => {});
		});
		await expect(
			client.run(() => bindings.invoke(notify, { message: "cancelled" }, { signal: AbortSignal.abort() })),
		).rejects.toMatchObject({ code: "aborted" });
		expect(calls).toBe(0);
		const controller = new AbortController();
		const pending = client.run(() => bindings.invoke(notify, { message: "wait" }, { signal: controller.signal }));
		const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
		const signal = await started.promise;
		controller.abort();
		await rejected;
		expect(signal.aborted).toBe(true);
	});

	it("rejects detached work after its originating operation finishes", async () => {
		const release = deferred<void>();
		let detached: Promise<unknown> | undefined;
		let calls = 0;
		const client = bindings.connect("client", [notify], async () => {
			calls++;
			return { displayed: true };
		});
		await client.run(() => {
			detached = release.promise.then(() => bindings.invoke(notify, { message: "late" }));
		});
		const rejected = expect(detached).rejects.toMatchObject({ code: "client_unavailable" });
		release.resolve();
		await rejected;
		expect(calls).toBe(0);
	});

	it("copies registration data and rejects duplicate clients and capabilities", async () => {
		const advertised = [{ id: notify.id, version: 1 }];
		const invoke = async () => ({ displayed: true });
		const client = bindings.connect("client", advertised, invoke);
		advertised[0].version = 2;
		expect(() => bindings.connect("client", [], invoke)).toThrow("already connected");
		expect(() => bindings.connect("other", [notify, notify], invoke)).toThrow("duplicate capability");
		await client.run(async () => expect(bindings.has(notify)).toBe(true));
	});

	it("cancels all parallel calls when the client closes", async () => {
		const started = deferred<void>();
		const signals: AbortSignal[] = [];
		const client = bindings.connect("client", [notify], async (_request, signal) => {
			signals.push(signal);
			if (signals.length === 24) started.resolve();
			return new Promise(() => {});
		});
		const pending = client.run(() =>
			Promise.allSettled(Array.from({ length: 24 }, () => bindings.invoke(notify, { message: "wait" }))),
		);
		await started.promise;
		client.disconnect();
		const results = await pending;
		for (const result of results) {
			expect(result).toMatchObject({ status: "rejected", reason: { code: "client_unavailable" } });
		}
		expect(signals.every((signal) => signal.aborted)).toBe(true);
	});
});
