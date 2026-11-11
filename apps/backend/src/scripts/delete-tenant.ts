import { runDeleteTenant } from "./delete-tenant-lib.js";

process.exitCode = await runDeleteTenant(process.argv.slice(2), process.env);
