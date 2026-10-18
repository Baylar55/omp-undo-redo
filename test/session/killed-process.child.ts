// Forked by killed-process.test.ts so a real process can be SIGKILLed mid-work.
// Usage: <undo|mid-turn> <cwd> <sessionId>. Sends "ready" at the kill point,
// then stays alive until killed.
import ompUndoRedo from "../../src/index.js";
import { context, FakeExtensionApi, type TestEntry } from "../helpers/index.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const [scenario, cwd, sessionId] = process.argv.slice(2);
const prompt: TestEntry = {
  id: "prompt",
  parentId: null,
  type: "message",
  message: { role: "user" },
};
const response: TestEntry = {
  id: "response",
  parentId: prompt.id,
  type: "message",
  message: { role: "assistant" },
};

setInterval(() => {}, 1 << 30);
const pi = new FakeExtensionApi();
// Long deadline: before_agent_start returns only once the before-snapshot ref exists.
ompUndoRedo(pi as never, { captureDeadlineMs: 60_000 });
const ctx = context(cwd, sessionId);
ctx.leaf = prompt.id;
ctx.branch = ctx.entries = [prompt];
await pi.emit("session_start", ctx);
await pi.emit("before_agent_start", ctx);
if (scenario === "undo") {
  await writeFile(join(cwd, "tracked.txt"), "changed\n");
  ctx.leaf = response.id;
  ctx.branch = ctx.entries = [prompt, response];
  await pi.emit("agent_end", ctx);
  // The intent is saved and the files restored; the session move never returns.
  ctx.navigateTree = () => {
    process.send?.("ready");
    return Promise.withResolvers<{ cancelled: boolean }>().promise;
  };
  void pi.runCommand("undo", ctx);
} else {
  // Mid-turn: the before-snapshot's owner ref exists, the after-snapshot never runs.
  process.send?.("ready");
}
