// Shared inspector transport for attached-device runners.
import { setTimeout as delay } from "node:timers/promises";
export class WebKitConnection {
  constructor(url, timeoutMs = 180_000) {
    this.timeoutMs = timeoutMs;
    this.socket = new WebSocket(url);
    this.targetId = undefined;
    this.innerId = 0;
    this.outerId = 0;
    this.pending = new Map();
    this.socket.addEventListener("close", () => this.rejectPending());
  }

  async open() {
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    const deadline = Date.now() + 15_000;
    while (!this.targetId && Date.now() < deadline) await delay(25);
    if (!this.targetId) throw new Error("WebKit did not announce a page target");
    return this;
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.method === "Target.targetCreated") {
      const info = message.params.targetInfo;
      if (!this.targetId && info.type === "page" && !info.isProvisional) this.targetId = info.targetId;
    }
    if (message.method === "Target.didCommitProvisionalTarget" && message.params.oldTargetId === this.targetId) {
      this.targetId = message.params.newTargetId;
    }
    if (message.method !== "Target.dispatchMessageFromTarget") return;
    const inner = JSON.parse(message.params.message);
    if (inner.method) {
      this.onNotification?.(inner);
      return;
    }
    const pending = this.pending.get(inner.id);
    if (!pending) return;
    this.pending.delete(inner.id);
    clearTimeout(pending.timer);
    if (inner.error) pending.reject(new Error(inner.error.message));
    else pending.resolve(inner.result);
  }

  command(method, params = {}) {
    const innerId = ++this.innerId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(innerId);
        reject(new Error(`${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(innerId, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({
          id: ++this.outerId,
          method: "Target.sendMessageToTarget",
          params: { targetId: this.targetId, message: JSON.stringify({ id: innerId, method, params }) },
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(innerId);
        reject(error);
      }
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const evaluation = await this.command("Runtime.evaluate", {
      expression,
      returnByValue: !awaitPromise,
      doNotPauseOnExceptionsAndMuteConsole: true,
    });
    if (evaluation.wasThrown) throw new Error(evaluation.result.description || "Evaluation failed");
    let result = evaluation.result;
    if (awaitPromise && result.objectId) {
      const awaited = await this.command("Runtime.awaitPromise", { promiseObjectId: result.objectId, returnByValue: true });
      if (awaited.wasThrown) throw new Error(awaited.result.description || "Promise rejected");
      result = awaited.result;
    }
    return result.value;
  }

  rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WebKit inspector connection closed"));
    }
    this.pending.clear();
  }

  close() {
    this.rejectPending();
    this.socket.close();
  }
}
