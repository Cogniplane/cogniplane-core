import { ManagedToolCatalog } from "./catalog.js";
import { ManagedToolFactoryRegistry } from "./factory.js";
import { registerBuiltinManagedTools } from "./register-builtin-managed-tools.js";

// Construct the managed-tool registries fresh per app build, then load the
// built-in catalog + factories. A private overlay package may register
// additional tools on these same instances during its own boot init later
// in the composition root.
export function buildManagedToolRegistries() {
  const managedToolCatalog = new ManagedToolCatalog();
  const managedToolFactoryRegistry = new ManagedToolFactoryRegistry();
  registerBuiltinManagedTools(managedToolCatalog, managedToolFactoryRegistry);
  return { managedToolCatalog, managedToolFactoryRegistry };
}

export type ManagedToolRegistries = ReturnType<typeof buildManagedToolRegistries>;
