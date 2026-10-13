import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export interface ClientCapability {
	id: string;
	version: number;
}

/** The host owns schemas; clients advertise only IDs and versions. */
export interface ClientBinding<Input extends TSchema = TSchema, Output extends TSchema = TSchema>
	extends ClientCapability {
	input: Input;
	output: Output;
}

export interface ClientBindingRequest extends ClientCapability {
	requestId: string;
	input: unknown;
}

/** Adapt a connection's reverse RPC here. Reject when the remote call fails. */
export type ClientBindingTransport = (request: ClientBindingRequest, signal: AbortSignal) => Promise<unknown>;

export type ClientBindingErrorCode =
	| "client_unavailable"
	| "binding_unavailable"
	| "invalid_input"
	| "invalid_output"
	| "aborted"
	| "timeout";

export class ClientBindingError extends Error {
	readonly code: ClientBindingErrorCode;

	constructor(code: ClientBindingErrorCode, message: string) {
		super(message);
		this.name = "ClientBindingError";
		this.code = code;
	}
}

export interface ClientBindingConnection {
	readonly id: string;
	/** Run the actual session operation here, after any host queue has dequeued it. */
	run<T>(operation: () => T | Promise<T>): Promise<T>;
	/** Reject outstanding calls and invalidate this connection, including old run handles. */
	disconnect(): void;
}

interface ConnectedClient {
	id: string;
	capabilities: ReadonlyMap<string, number>;
	invoke: ClientBindingTransport;
	controller: AbortController;
}

interface ClientOrigin {
	client: ConnectedClient;
	controller: AbortController;
}

/**
 * Routes extension calls to the connection that started the current operation.
 * Each instance owns its connections and async context. No process-wide active client.
 */
export class ClientBindings {
	private readonly clients = new Map<string, ConnectedClient>();
	private readonly origin = new AsyncLocalStorage<ClientOrigin>();

	connect(
		id: string,
		capabilities: readonly ClientCapability[],
		invoke: ClientBindingTransport,
	): ClientBindingConnection {
		if (!id || this.clients.has(id)) {
			throw new ClientBindingError("client_unavailable", `Client ID is empty or already connected: ${id}`);
		}
		const advertised = new Map<string, number>();
		for (const capability of capabilities) {
			if (
				!capability.id ||
				!Number.isSafeInteger(capability.version) ||
				capability.version < 1 ||
				advertised.has(capability.id)
			) {
				throw new ClientBindingError("binding_unavailable", `Invalid or duplicate capability: ${capability.id}`);
			}
			advertised.set(capability.id, capability.version);
		}
		const client: ConnectedClient = { id, capabilities: advertised, invoke, controller: new AbortController() };
		this.clients.set(id, client);
		return {
			id,
			run: async <T>(operation: () => T | Promise<T>): Promise<T> => {
				if (client.controller.signal.aborted) {
					throw new ClientBindingError("client_unavailable", `Client ${id} is disconnected`);
				}
				const context: ClientOrigin = { client, controller: new AbortController() };
				try {
					return await this.origin.run(context, operation);
				} finally {
					context.controller.abort(new ClientBindingError("aborted", "Originating operation has finished"));
				}
			},
			disconnect: () => {
				if (this.clients.get(id) !== client) return;
				this.clients.delete(id);
				client.controller.abort(new ClientBindingError("client_unavailable", `Client ${id} disconnected`));
			},
		};
	}

	has(binding: ClientCapability): boolean {
		const context = this.origin.getStore();
		return (
			!!context &&
			!context.controller.signal.aborted &&
			!context.client.controller.signal.aborted &&
			context.client.capabilities.get(binding.id) === binding.version
		);
	}

	async invoke<Input extends TSchema, Output extends TSchema>(
		binding: ClientBinding<Input, Output>,
		input: Static<Input>,
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<Static<Output>> {
		const context = this.origin.getStore();
		if (!context || context.controller.signal.aborted || context.client.controller.signal.aborted) {
			throw new ClientBindingError("client_unavailable", "No connected originating client for this operation");
		}
		if (!this.has(binding)) {
			throw new ClientBindingError(
				"binding_unavailable",
				`Client ${context.client.id} does not provide ${binding.id}@${binding.version}`,
			);
		}
		if (!Value.Check(binding.input, input)) {
			throw new ClientBindingError("invalid_input", `Input does not match ${binding.id}@${binding.version}`);
		}
		const timeoutMs = options.timeoutMs ?? 10_000;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
			throw new RangeError("timeoutMs must be an integer between 1 and 2147483647");
		}

		const controller = new AbortController();
		const signals = [
			context.client.controller.signal,
			context.controller.signal,
			...(options.signal ? [options.signal] : []),
		];
		const parentSignal = AbortSignal.any(signals);
		const onAbort = () => {
			const reason: unknown = parentSignal.reason;
			controller.abort(
				reason instanceof ClientBindingError
					? reason
					: new ClientBindingError("aborted", `${binding.id} was aborted`),
			);
		};
		if (parentSignal.aborted) {
			onAbort();
			throw controller.signal.reason;
		}
		parentSignal.addEventListener("abort", onAbort, { once: true });
		let rejectCancellation: (error: unknown) => void = () => {};
		const cancellation = new Promise<never>((_resolve, reject) => {
			rejectCancellation = reject;
		});
		const onCancelled = () => rejectCancellation(controller.signal.reason);
		controller.signal.addEventListener("abort", onCancelled, { once: true });
		const timer = setTimeout(() => {
			controller.abort(new ClientBindingError("timeout", `${binding.id} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		try {
			const output = await Promise.race([
				Promise.resolve().then(() => {
					controller.signal.throwIfAborted();
					return context.client.invoke(
						{ id: binding.id, version: binding.version, requestId: randomUUID(), input },
						controller.signal,
					);
				}),
				cancellation,
			]);
			controller.signal.throwIfAborted();
			if (!Value.Check(binding.output, output)) {
				throw new ClientBindingError("invalid_output", `Output does not match ${binding.id}@${binding.version}`);
			}
			return output;
		} finally {
			clearTimeout(timer);
			parentSignal.removeEventListener("abort", onAbort);
			controller.signal.removeEventListener("abort", onCancelled);
		}
	}

	/** Disconnect every client when shutting down the host. */
	dispose(): void {
		const clients = [...this.clients.values()];
		this.clients.clear();
		for (const client of clients) {
			client.controller.abort(new ClientBindingError("client_unavailable", "Client bindings disposed"));
		}
		this.origin.disable();
	}
}
