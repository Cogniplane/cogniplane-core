// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  submitTotpCode: vi.fn(), submitRecoveryCode: vi.fn(), startSignInEnrollment: vi.fn(), confirmSignInEnrollment: vi.fn(),
  submitPasskeySecondFactor: vi.fn(), enrollPasskeyInSignIn: vi.fn()
}));
const browser = vi.hoisted(() => ({ passkeysSupported: vi.fn(() => true) }));
vi.mock("../../lib/passkey-browser", async (importOriginal) => ({ ...(await importOriginal<object>()), ...browser }));
vi.mock("../../lib/local-auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/local-auth-api")>();
  return { ...actual, ...api };
});

import { LocalAuthError } from "../../lib/local-auth-api";
import { RecoveryCodesPanel } from "./recovery-codes-panel";
import { SignInSteps } from "./sign-in-steps";
import { TotpEnrollment } from "./totp-enrollment";

const ENROLLMENT = { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/Cogniplane:dana%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Cogniplane" };
const CODES = ["AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH"];

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("SignInSteps", () => {
  it("a code from the app starts the session", async () => {
    api.submitTotpCode.mockResolvedValue({ accessToken: "tok-mfa", user: {} });
    const onSession = vi.fn();
    render(<SignInSteps first={{ next: "mfa", methods: ["totp", "recovery_code"] }} onSession={onSession} onRestart={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: " 123456 " } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onSession).toHaveBeenCalledWith("tok-mfa"));
    expect(api.submitTotpCode).toHaveBeenCalledWith("123456");
  });

  it("a wrong code shows the reason and does not start a session", async () => {
    api.submitTotpCode.mockRejectedValue(new LocalAuthError("invalid_code", 401));
    const onSession = vi.fn();
    render(<SignInSteps first={{ next: "mfa", methods: ["totp", "recovery_code"] }} onSession={onSession} onRestart={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/not correct/i);
    expect(onSession).not.toHaveBeenCalled();
  });

  it("a recovery code leads to a new enrolment, then the new codes, then the session", async () => {
    api.submitRecoveryCode.mockResolvedValue({ next: "enroll" });
    api.startSignInEnrollment.mockResolvedValue(ENROLLMENT);
    api.confirmSignInEnrollment.mockResolvedValue({ accessToken: "tok-new", user: {}, recoveryCodes: CODES });
    const onSession = vi.fn();
    render(<SignInSteps first={{ next: "mfa", methods: ["totp", "recovery_code"] }} onSession={onSession} onRestart={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code" }));
    fireEvent.change(screen.getByLabelText("Recovery code"), { target: { value: "aaaa-bbbb-cccc-dddd" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.change(await screen.findByLabelText("Code from the app"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on two-step verification" }));

    const list = await screen.findByRole("list", { name: "Recovery codes" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(CODES);
    // The session waits until the person confirms that they saved the codes.
    expect(onSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "I saved my codes" }));
    expect(onSession).toHaveBeenCalledWith("tok-new");
    expect(api.confirmSignInEnrollment).toHaveBeenCalledWith("654321");
  });

  it("asks for an unused saved recovery code when recovery verification rejects it", async () => {
    api.submitRecoveryCode.mockRejectedValue(new LocalAuthError("invalid_code", 401));
    const onSession = vi.fn();
    render(<SignInSteps first={{ next: "mfa", methods: ["totp", "recovery_code"] }} onSession={onSession} onRestart={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code" }));
    const input = screen.getByLabelText("Recovery code");
    fireEvent.change(input, { target: { value: "AAAA-BBBB-CCCC-DDDD" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/unused.*saved recovery codes/i);
    expect(alert.textContent).not.toMatch(/from your app/i);
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(onSession).not.toHaveBeenCalled();
    expect(api.startSignInEnrollment).not.toHaveBeenCalled();
  });

  it("offers a way back to the password", () => {
    const onRestart = vi.fn();
    render(<SignInSteps first={{ next: "mfa", methods: ["totp", "recovery_code"] }} onSession={vi.fn()} onRestart={onRestart} />);
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    expect(onRestart).toHaveBeenCalled();
  });
});

describe("TotpEnrollment", () => {
  it("links a server failure to Turn on after the button, without marking the code invalid", async () => {
    render(<TotpEnrollment start={vi.fn().mockResolvedValue(ENROLLMENT)}
      confirm={vi.fn().mockRejectedValue(new LocalAuthError("network_error", 503))} onConfirmed={vi.fn()} />);
    const field = await screen.findByLabelText("Code from the app");
    fireEvent.change(field, { target: { value: "123456" } });
    const button = screen.getByRole("button", { name: "Turn on two-step verification" });
    button.focus();
    fireEvent.click(button);
    const alert = await screen.findByRole("alert");
    expect(button.getAttribute("aria-describedby")).toBe(alert.id);
    expect(button.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("starts the enrolment once under Strict Mode", async () => {
    const start = vi.fn().mockResolvedValue(ENROLLMENT);
    render(<StrictMode><TotpEnrollment start={start} confirm={vi.fn()} onConfirmed={vi.fn()} /></StrictMode>);
    await screen.findByLabelText("Code from the app");
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByText("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP")).toBeTruthy();
  });

  it("shows why the enrolment could not start", async () => {
    const start = vi.fn().mockRejectedValue(new LocalAuthError("sign_in_expired", 401));
    render(<TotpEnrollment start={start} confirm={vi.fn()} onConfirmed={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/took too long/i);
  });
});

describe("RecoveryCodesPanel", () => {
  it("copies the codes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<RecoveryCodesPanel codes={CODES} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy codes" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODES.join("\n")));
    expect(screen.getByRole("status").textContent).toBe("Copied.");
  });
});

describe("SignInSteps with passkeys", () => {
  it("offers the passkey first when the account has one, and signs in with it", async () => {
    browser.passkeysSupported.mockReturnValue(true);
    api.submitPasskeySecondFactor.mockResolvedValue({ accessToken: "tok-pk", user: {} });
    const onSession = vi.fn();
    render(<SignInSteps first={{ next: "mfa", methods: ["passkey", "recovery_code"] }} onSession={onSession} onRestart={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Use my authenticator app" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use a passkey" }));
    await waitFor(() => expect(onSession).toHaveBeenCalledWith("tok-pk"));
  });

  it("a cancelled passkey prompt explains itself and leaves the other ways open", async () => {
    browser.passkeysSupported.mockReturnValue(true);
    const { PasskeyCeremonyError } = await vi.importActual<typeof import("../../lib/passkey-browser")>("../../lib/passkey-browser");
    api.submitPasskeySecondFactor.mockRejectedValue(new PasskeyCeremonyError("passkey_cancelled"));
    render(<SignInSteps first={{ next: "mfa", methods: ["passkey", "totp", "recovery_code"] }} onSession={vi.fn()} onRestart={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Use a passkey" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cancelled or took too long/i);
    fireEvent.click(screen.getByRole("button", { name: "Use my authenticator app" }));
    expect(screen.getByLabelText("Code")).toBeTruthy();
  });

  it("without browser support, the passkey method is not offered", () => {
    browser.passkeysSupported.mockReturnValue(false);
    render(<SignInSteps first={{ next: "mfa", methods: ["passkey", "totp", "recovery_code"] }} onSession={vi.fn()} onRestart={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Use a passkey" })).toBeNull();
    expect(screen.getByLabelText("Code")).toBeTruthy();
  });

  it("enrolment can add a passkey, then shows the recovery codes before the session", async () => {
    browser.passkeysSupported.mockReturnValue(true);
    api.enrollPasskeyInSignIn.mockResolvedValue({ accessToken: "tok-en", user: {}, recoveryCodes: CODES });
    const onSession = vi.fn();
    render(<SignInSteps first={{ next: "enroll" }} passkeys onSession={onSession} onRestart={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    await screen.findByRole("list", { name: "Recovery codes" });
    expect(onSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "I saved my codes" }));
    expect(onSession).toHaveBeenCalledWith("tok-en");
    expect(api.startSignInEnrollment).not.toHaveBeenCalled();
  });

  it("enrolment without passkeys goes straight to the authenticator app", async () => {
    api.startSignInEnrollment.mockResolvedValue(ENROLLMENT);
    render(<SignInSteps first={{ next: "enroll" }} passkeys={false} onSession={vi.fn()} onRestart={vi.fn()} />);
    await screen.findByLabelText("Code from the app");
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
  });
});

describe("pending auth transitions", () => {
  it("keeps the method and restart stable during deferred verification", async () => {
    let resolve!: (value: unknown) => void;
    api.submitTotpCode.mockReturnValue(new Promise(done => { resolve = done; }));
    const onSession = vi.fn();
    const onRestart = vi.fn();
    render(<SignInSteps first={{ next: "mfa", methods: ["totp", "recovery_code"] }} onSession={onSession} onRestart={onRestart} />);
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const recovery = screen.getByRole("button", { name: "Use a recovery code" });
    const restart = screen.getByRole("button", { name: "Start again" });
    fireEvent.click(recovery);
    fireEvent.click(restart);
    expect(screen.queryByLabelText("Recovery code")).toBeNull();
    expect(onRestart).not.toHaveBeenCalled();
    expect(recovery.hasAttribute("disabled")).toBe(true);
    expect(restart.hasAttribute("disabled")).toBe(true);
    resolve({ accessToken: "synthetic-mfa", user: {} });
    await waitFor(() => expect(onSession).toHaveBeenCalledExactlyOnceWith("synthetic-mfa"));
  });

  it("lets the user leave a stalled enrollment start", () => {
    // The start request has no timeout, so it must not lock the only exit.
    api.startSignInEnrollment.mockReturnValue(new Promise(() => {}));
    const onRestart = vi.fn();
    render(<SignInSteps first={{ next: "enroll" }} onSession={vi.fn()} onRestart={onRestart} />);
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("keeps restart locked while a code is checked", async () => {
    let start!: (value: unknown) => void;
    let confirm!: (value: unknown) => void;
    api.startSignInEnrollment.mockReturnValue(new Promise(done => { start = done; }));
    api.confirmSignInEnrollment.mockReturnValue(new Promise(done => { confirm = done; }));
    const onRestart = vi.fn();
    render(<SignInSteps first={{ next: "enroll" }} onSession={vi.fn()} onRestart={onRestart} />);
    const restart = screen.getByRole("button", { name: "Start again" });
    start(ENROLLMENT);
    fireEvent.change(await screen.findByLabelText("Code from the app"), { target: { value: "123456" } });
    expect(restart.hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Turn on two-step verification" }));
    fireEvent.click(restart);
    expect(onRestart).not.toHaveBeenCalled();
    confirm({ accessToken: "synthetic-enrolled", user: {}, recoveryCodes: CODES });
    await screen.findByRole("list", { name: "Recovery codes" });
    expect(api.startSignInEnrollment).toHaveBeenCalledTimes(1);
    expect(api.confirmSignInEnrollment).toHaveBeenCalledTimes(1);
  });
});

it("explains denied copy and download while keeping manual selection and acknowledgement available", async () => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("Synthetic denied")) }, configurable: true });
  const original = URL.createObjectURL;
  URL.createObjectURL = vi.fn(() => { throw new Error("Synthetic denied"); });
  const onDone = vi.fn();
  try {
    render(<RecoveryCodesPanel codes={CODES} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy codes" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/copy did not work.*select and copy/i);
    expect(screen.getByRole("list", { name: "Recovery codes" }).getAttribute("tabindex")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(screen.getByRole("alert").textContent).toMatch(/download did not work/i);
    // Copy already failed, so the download message does not send the person back to it.
    expect(screen.getByRole("alert").textContent).not.toMatch(/copy codes|use copy/i);
    fireEvent.click(screen.getByRole("button", { name: "I saved my codes" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  } finally { URL.createObjectURL = original; }
});

it("awaits the sign-in completion promise and retains codes when it fails", async () => {
  browser.passkeysSupported.mockReturnValue(true);
  api.enrollPasskeyInSignIn.mockResolvedValue({ accessToken: "synthetic-pending-session", user: {}, recoveryCodes: CODES });
  let reject!: (error: Error) => void;
  const onSession = vi.fn().mockReturnValue(new Promise((_done, fail) => { reject = fail; }));
  render(<SignInSteps first={{ next: "enroll" }} passkeys onSession={onSession} onRestart={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
  fireEvent.click(await screen.findByRole("button", { name: "I saved my codes" }));
  const pending = screen.getByRole("button", { name: "Continuing…" });
  fireEvent.click(pending);
  expect(pending.hasAttribute("disabled")).toBe(false);
  expect(pending.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("list", { name: "Recovery codes" }).textContent).toContain(CODES[0]);
  expect(onSession).toHaveBeenCalledExactlyOnceWith("synthetic-pending-session");
  reject(new Error("Synthetic workspace failure"));
  const error = await screen.findByRole("alert");
  expect(error.textContent).toMatch(/could not continue/i);
  const retry = screen.getByRole("button", { name: "I saved my codes" });
  expect(retry.hasAttribute("disabled")).toBe(false);
  expect(error.id).not.toBe("");
  expect(retry.getAttribute("aria-describedby")).toBe(error.id);
  expect(retry.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(api.enrollPasskeyInSignIn).toHaveBeenCalledTimes(1);
});

it("focuses a changed step title and associates only field-specific code errors", async () => {
  api.submitTotpCode.mockRejectedValueOnce(new LocalAuthError("invalid_code", 401)).mockRejectedValueOnce(new LocalAuthError("network_error", 503));
  render(<SignInSteps first={{ next: "mfa", methods: ["totp", "recovery_code"] }} onSession={vi.fn()} onRestart={vi.fn()} />);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Enter your verification code" }));
  fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const alert = await screen.findByRole("alert");
  expect(screen.getByLabelText("Code").getAttribute("aria-describedby")).toBe(alert.id);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/cannot be reached/i));
  expect(screen.getByLabelText("Code").getAttribute("aria-invalid")).toBeNull();
  const retry = screen.getByRole("button", { name: "Continue" });
  const requestError = screen.getByRole("alert");
  expect(retry.getAttribute("aria-describedby")).toBe(requestError.id);
  expect(retry.compareDocumentPosition(requestError) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use a recovery code" }));
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Use a recovery code" }));
});

it("holds the enrollment method and restart while a passkey is pending, then recovers after failure", async () => {
  browser.passkeysSupported.mockReturnValue(true);
  let reject!: (error: Error) => void;
  api.enrollPasskeyInSignIn.mockReturnValue(new Promise((_done, fail) => { reject = fail; }));
  const restart = vi.fn();
  render(<SignInSteps first={{ next: "enroll" }} passkeys onSession={vi.fn()} onRestart={restart} />);
  fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
  fireEvent.click(screen.getByRole("button", { name: "Start again" }));
  const app = screen.getByRole("button", { name: "Use an authenticator app instead" });
  fireEvent.click(app);
  expect(app.hasAttribute("disabled")).toBe(true);
  expect(restart).not.toHaveBeenCalled();
  expect(api.startSignInEnrollment).not.toHaveBeenCalled();
  reject(new Error("Synthetic passkey failure"));
  await screen.findByRole("alert");
  expect(app.hasAttribute("disabled")).toBe(false);
});

describe("pending ownership and focus", () => {
  it("keeps the code field read-only and the submit focused while a code check runs, then keeps focus after failure", async () => {
    let reject!: (error: Error) => void;
    api.submitTotpCode.mockReturnValue(new Promise((_done, fail) => { reject = fail; }));
    render(<SignInSteps first={{ next: "mfa", methods: ["totp", "recovery_code"] }} onSession={vi.fn()} onRestart={vi.fn()} />);
    const input = screen.getByLabelText("Code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "123456" } });
    const submit = screen.getByRole("button", { name: "Continue" });
    submit.focus();
    fireEvent.click(submit);
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(submit.hasAttribute("disabled")).toBe(false);
    expect(input.readOnly).toBe(true);
    fireEvent.change(input, { target: { value: "999999" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.click(submit);
    expect(api.submitTotpCode).toHaveBeenCalledExactlyOnceWith("123456");
    expect(document.activeElement).toBe(submit);
    reject(new LocalAuthError("invalid_code", 401));
    const alert = await screen.findByRole("alert");
    expect(document.activeElement).toBe(submit);
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe("123456");
  });

  it("does not move focus to a new step when the person moved focus outside the task", async () => {
    let resolve!: (value: unknown) => void;
    api.submitRecoveryCode.mockReturnValue(new Promise(done => { resolve = done; }));
    api.startSignInEnrollment.mockReturnValue(new Promise(() => {}));
    render(<><div data-auth-scope=""><SignInSteps first={{ next: "mfa", methods: ["totp", "recovery_code"] }} onSession={vi.fn()} onRestart={vi.fn()} /></div><button type="button">Outside sample</button></>);
    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code" }));
    fireEvent.change(screen.getByLabelText("Recovery code"), { target: { value: "AAAA-BBBB" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const outside = screen.getByRole("button", { name: "Outside sample" });
    outside.focus();
    resolve({ next: "enroll" });
    await screen.findByRole("heading", { name: "Set up an authenticator app" });
    expect(document.activeElement).toBe(outside);
  });

  it("makes Start again the primary next step after a failed app start, without a retry claim", async () => {
    api.startSignInEnrollment.mockRejectedValue(new LocalAuthError("network_error", 0));
    const onRestart = vi.fn();
    render(<SignInSteps first={{ next: "enroll" }} onSession={vi.fn()} onRestart={onRestart} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not start/i);
    expect(alert.textContent).not.toMatch(/try again/i);
    expect(screen.getByText(/start again to sign in and begin a new setup/i)).toBeTruthy();
    const restarts = screen.getAllByRole("button", { name: "Start again" });
    expect(restarts).toHaveLength(1);
    fireEvent.click(restarts[0]);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(api.startSignInEnrollment).toHaveBeenCalledTimes(1);
  });

  it("lets a person go back from the app to the passkey without a second app start", async () => {
    browser.passkeysSupported.mockReturnValue(true);
    api.startSignInEnrollment.mockResolvedValue(ENROLLMENT);
    const onRestart = vi.fn();
    render(<SignInSteps first={{ next: "enroll" }} passkeys onSession={vi.fn()} onRestart={onRestart} />);
    fireEvent.click(screen.getByRole("button", { name: "Use an authenticator app instead" }));
    await screen.findByLabelText("Code from the app");
    const back = screen.getByRole("button", { name: "Use a passkey instead" }) as HTMLButtonElement;
    // The switch waits until the app start has settled.
    await waitFor(() => expect(back.disabled).toBe(false));
    fireEvent.click(back);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Set up two-step verification" }));
    expect(screen.getByRole("button", { name: "Add a passkey" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use an authenticator app instead" }));
    await screen.findByLabelText("Code from the app");
    expect(api.startSignInEnrollment).toHaveBeenCalledTimes(1);
    expect(onRestart).not.toHaveBeenCalled();
  });

  it("names a manual key group and keeps all key characters as one selectable text", async () => {
    api.startSignInEnrollment.mockResolvedValue(ENROLLMENT);
    render(<SignInSteps first={{ next: "enroll" }} onSession={vi.fn()} onRestart={vi.fn()} />);
    await screen.findByLabelText("Code from the app");
    const key = screen.getByRole("group", { name: "Setup key" });
    expect(key.textContent?.replace(/ /g, "")).toBe(ENROLLMENT.secret);
    expect(key.getAttribute("tabindex")).toBe("0");
  });

  it("starts one copy for repeated activation and keeps the copy button focused", async () => {
    let resolve!: () => void;
    const copyCodes = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    render(<RecoveryCodesPanel codes={CODES} onDone={vi.fn()} copyCodes={copyCodes} downloadCodes={vi.fn()} />);
    const copy = screen.getByRole("button", { name: "Copy codes" });
    copy.focus();
    fireEvent.click(copy);
    fireEvent.click(copy);
    expect(copyCodes).toHaveBeenCalledTimes(1);
    expect(copy.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(copy);
    expect((screen.getByRole("button", { name: "I saved my codes" }) as HTMLButtonElement).disabled).toBe(true);
    resolve();
    expect((await screen.findByRole("status")).textContent).toBe("Copied.");
    expect(document.activeElement).toBe(copy);
  });
});
