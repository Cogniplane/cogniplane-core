export type DeleteTenantArguments = {
  tenantId: string;
  requestId: string;
  thirdPartyDisposition: string;
  backupDisposition: string;
};

const VALUE_FLAGS = new Set([
  "--tenant-id",
  "--confirm",
  "--request-id",
  "--third-party-disposition",
  "--backup-disposition"
]);

function usage(): never {
  throw new Error(
    "Usage: delete-tenant --tenant-id <id> --confirm <same-id> --request-id <ticket> " +
      "--third-party-disposition <text> --backup-disposition <text> --maintenance-confirmed"
  );
}

/**
 * Parse and check the delete-tenant command line. It refuses to go on unless
 * --confirm repeats the tenant id and the operator confirms that the backend
 * is stopped, so a typo cannot delete the wrong tenant or a live one. Unknown
 * and repeated flags are refused too: a mistyped "--dry-run yes" must not run
 * a real deletion, and a second --tenant-id must not replace the first.
 */
export function parseDeleteTenantArguments(argv: string[]): DeleteTenantArguments {
  const values = new Map<string, string>();
  let maintenanceConfirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--maintenance-confirmed") {
      if (maintenanceConfirmed) usage();
      maintenanceConfirmed = true;
      continue;
    }
    if (!flag || !VALUE_FLAGS.has(flag) || values.has(flag)) usage();
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    values.set(flag, value);
    index += 1;
  }

  const tenantId = values.get("--tenant-id");
  const confirm = values.get("--confirm");
  const requestId = values.get("--request-id");
  const thirdPartyDisposition = values.get("--third-party-disposition");
  const backupDisposition = values.get("--backup-disposition");
  if (!tenantId || !confirm || !requestId || !thirdPartyDisposition || !backupDisposition) usage();
  if (confirm !== tenantId) {
    throw new Error("--confirm must exactly match --tenant-id.");
  }
  if (!maintenanceConfirmed) {
    throw new Error(
      "--maintenance-confirmed is required after the backend has stopped gracefully and database writes are quiesced."
    );
  }
  return {
    tenantId,
    requestId,
    thirdPartyDisposition,
    backupDisposition
  };
}
