# Client bindings

`ClientBindings` lets daemon extensions call capabilities supplied by the client that started an operation. For example, a notification tool can show a notification in a browser or a terminal. The extension uses the same schema and call in either case.

The host owns the binding schemas. A connected client advertises binding IDs and integer versions, then supplies a reverse RPC transport. Pi checks the input and output, routes calls through async context, and rejects calls on timeout, abort, or disconnect. Connections belong to a registry instance. Different sessions and clients can run concurrently without a shared active-client variable.

```typescript
import { ClientBindings, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const bindings = new ClientBindings();
const notify = {
  id: "ui.notify",
  version: 1,
  input: Type.Object({ message: Type.String({ minLength: 1 }) }),
  output: Type.Object({ displayed: Type.Boolean() }),
};

const extension: ExtensionFactory = (pi) => {
  pi.registerTool({
    name: "notify",
    label: "Notify",
    description: "Display a notification on the originating client",
    parameters: notify.input,
    async execute(_id, input, signal) {
      const result = await bindings.invoke(notify, input, { signal });
      return {
        content: [{ type: "text", text: result.displayed ? "Displayed" : "Dismissed" }],
        details: result,
      };
    },
  });
};
```

Pass `extension` through `DefaultResourceLoader.extensionFactories` when creating a session. Commands and hooks can use the same `bindings.invoke()` call. `bindings.has(notify)` checks whether the current originating connection advertises that exact version.

After authenticating a connection, the daemon registers it and binds session operations to its handle:

```typescript
const client = bindings.connect(connectionId, advertisedCapabilities, async (request, signal) => {
  // The transport sends { requestId, id, version, input } to this connection
  // and resolves with its matching result. Bind responses to this connection.
  return transport.request(request, { signal });
});

await client.run(() => session.prompt(text));

// On connection close:
client.disconnect();

// On host shutdown:
bindings.dispose();
```

`run()` binds tools, commands, hooks, and their awaited async work. Calls outside an active operation fail with `client_unavailable`. Outstanding calls receive cancellation when the operation finishes. Disconnect invalidates old handles even when a new connection reuses the same ID.

The default call timeout is 10 seconds. Set `timeoutMs` per invocation for longer dialogs. `ClientBindingError.code` distinguishes `client_unavailable`, `binding_unavailable`, `invalid_input`, `invalid_output`, `aborted`, and `timeout`. Transport errors propagate. Cancellation cannot undo an action the client already performed.

## Daemon integration

Use the authenticated connection's handle. Do not select a client from an ID supplied with each prompt. Keep credentials and session storage in the daemon.

Serialize operations targeting the same session. If the daemon queues prompts, queue the connection handle with each prompt and call `client.run()` when that prompt starts executing. Pi's existing `steer()` and `followUp()` queues do not carry client identity. Work added through those queues inherits the running operation's client. To preserve a different sender, queue a new top-level operation in the host.

This API supplies capability negotiation and invocation. The daemon still supplies the socket or WebSocket transport, authentication, session ownership, persistence, and reconnect replay. It does not start a listener or change the existing stdio RPC protocol.
