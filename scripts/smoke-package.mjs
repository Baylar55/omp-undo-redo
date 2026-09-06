import ompUndoRedo from "../index.js";

const registered = new Set();

ompUndoRedo({
  on() {},
  registerCommand(name, config) {
    if (typeof config?.handler !== "function") {
      throw new Error(`Command '${name}' registered without a callable handler.`);
    }
    registered.add(name);
  },
});

for (const name of ["undo", "redo"]) {
  if (!registered.has(name)) throw new Error(`Required command '${name}' was not registered.`);
}

console.log("Package entry smoke test passed successfully.");
