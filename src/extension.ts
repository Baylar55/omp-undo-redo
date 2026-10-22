import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerCommands } from "./host/commands.js";
import { registerEvents } from "./host/events.js";
import { BOOT_HOUSEKEEPING_FALLBACK_MS, startBootHousekeeping } from "./session/housekeeping.js";
import { createRegistry } from "./session/registry.js";
import { createServices } from "./session/services.js";
import type { OmpUndoRedoDependencies } from "./session/services.js";

export type { OmpUndoRedoDependencies } from "./session/services.js";

export default function ompUndoRedo(pi: ExtensionAPI, deps: OmpUndoRedoDependencies = {}): void {
  const services = createServices(deps);
  const registry = createRegistry(services);
  registerEvents(pi, services, registry);
  registerCommands(pi, registry);

  const bootFallback = setTimeout(() => {
    if (!services.flags.servesSubagent && !services.flags.closing) {
      void startBootHousekeeping(services);
    }
  }, BOOT_HOUSEKEEPING_FALLBACK_MS);
  bootFallback.unref?.();
}
