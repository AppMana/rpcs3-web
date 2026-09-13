import { afterEach, expect, it, vi } from "vitest";
import { WebKitConnection } from "../scripts/webkit-connection.mjs";

class Socket extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => {
      this.dispatchEvent(new Event("open"));
      this.message({ method: "Target.targetCreated", params: { targetInfo: { type: "page", targetId: "page" } } });
    });
  }
  message(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  send(value) {
    const request = JSON.parse(JSON.parse(value).params.message);
    if (request.method === "hold") return;
    this.message({ method: "Target.dispatchMessageFromTarget", params: { message: JSON.stringify({ id: request.id, result: { value: 42 } }) } });
  }
  close() {}
}
afterEach(() => vi.unstubAllGlobals());
it("registers pending commands before even an immediate inspector response", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const connection = await new WebKitConnection("ws://test", 100).open();
  await expect(connection.command("read")).resolves.toEqual({ value: 42 });
  connection.close();
});
it("rejects pending work when the connection is closed", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const connection = await new WebKitConnection("ws://test", 100).open();
  const result = expect(connection.command("hold")).rejects.toThrow("closed");
  connection.close();
  await result;
  expect(connection.pending.size).toBe(0);
});

it("rejects pending work immediately when the remote socket closes", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const connection = await new WebKitConnection("ws://test", 10_000).open();
  const result = expect(connection.command("hold")).rejects.toThrow("closed");
  connection.socket.dispatchEvent(new Event("close"));
  await result;
  expect(connection.pending.size).toBe(0);
});

it("delivers memory notifications independently of pending command responses", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const connection = await new WebKitConnection("ws://test", 100).open();
  const notification = { method: "Memory.trackingUpdate", params: { event: { categories: [{ type: "jit", size: 1024 }] } } };
  connection.onNotification = vi.fn();
  connection.socket.message({ method: "Target.dispatchMessageFromTarget", params: { message: JSON.stringify(notification) } });
  expect(connection.onNotification).toHaveBeenCalledWith(notification);
  await expect(connection.command("read")).resolves.toEqual({ value: 42 });
  connection.close();
});
