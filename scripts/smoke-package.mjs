import ompUndoRedo from "../index.js";

if (typeof ompUndoRedo !== "function") {
  console.error("Package default export is not a function.");
  process.exit(1);
}

const registeredCommands = new Map();
const registeredEvents = new Map();

const fakeApi = {
  on(event, handler) {
    if (typeof handler !== "function") {
      throw new Error(`Event handler for '${event}' is not a function.`);
    }
    registeredEvents.set(event, (registeredEvents.get(event) || 0) + 1);
  },
  registerCommand(name, config) {
    if (registeredCommands.has(name)) {
      throw new Error(`Duplicate command registration for '${name}'.`);
    }
    if (!config || typeof config.handler !== "function") {
      throw new Error(`Command '${name}' missing callable handler.`);
    }
    registeredCommands.set(name, config);
  },
};

try {
  ompUndoRedo(fakeApi);
} catch (error) {
  console.error("Failed to invoke default extension export:", error);
  process.exit(1);
}

const requiredCommands = ["undo", "redo"];
for (const cmd of requiredCommands) {
  const config = registeredCommands.get(cmd);
  if (!config) {
    console.error(`Required command '${cmd}' was not registered.`);
    process.exit(1);
  }
  if (typeof config.handler !== "function") {
    console.error(`Registered command '${cmd}' handler is not a function.`);
    process.exit(1);
  }
}

if (registeredCommands.size !== requiredCommands.length) {
  console.error(
    `Unexpected commands registered: expected ${requiredCommands.length}, got ${registeredCommands.size}.`,
  );
  process.exit(1);
}

console.log("Package entry smoke test passed successfully.");
