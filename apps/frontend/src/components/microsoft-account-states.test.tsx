// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { MicrosoftConnectionStatus } from "../../../../private/sharepoint-overlay-contracts/src/index";
import { MicrosoftConnectionSection } from "../../../../private/sharepoint-overlay-frontend/src/components/microsoft-connection-section";
import { connectionDates as dates, connectionHandlers as handlers, describeConnectionAccountStates } from "../test-helpers/oauth-account-states";

const microsoft: MicrosoftConnectionStatus = { configured: true, tenantEnabled: true, userConnection: { ...dates, microsoftUserId: "synthetic-ms-user", microsoftEmail: "sample@example.test", microsoftDisplayName: "Sample member", scopes: [] } };
afterEach(cleanup);

describeConnectionAccountStates([
  { provider: "Microsoft 365", identity: "Connected as Sample member", mount: (props, c) => <MicrosoftConnectionSection {...props} {...c} status={c.unknown ? null : { ...microsoft, tenantEnabled: !c.disabled, userConnection: { ...microsoft.userConnection!, suspended: c.suspended ?? false } }} /> }
]);

it("does not offer Microsoft confirmation without an attested email", () => {
  const props = handlers();
  render(<MicrosoftConnectionSection {...props} status={{ ...microsoft, userConnection: { ...microsoft.userConnection!, microsoftEmail: null, suspended: true } }} />);
  expect(screen.getByText(/The agent does not use this connection. Connect again, or disconnect it./)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Confirm connection" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(props.onDisconnect).toHaveBeenCalledOnce();
  expect(props.onConfirm).not.toHaveBeenCalled();
});
