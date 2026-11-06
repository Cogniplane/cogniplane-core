import { completeAccountSetup, completePasswordReset, fetchAuthConfig, signInWithPassword, signInWithPasskey, submitTotpCode, submitRecoveryCode, submitPasskeySecondFactor, startSignInEnrollment, confirmSignInEnrollment, enrollPasskeyInSignIn, requestPasswordReset } from "../../lib/local-auth-api";

import { copyRecoveryCodes, downloadRecoveryCodes } from "./recovery-codes-panel";

// Explicit action props let presentation specimens run without session mutations.
export const authFlowActions = { copyRecoveryCodes, downloadRecoveryCodes, completeAccountSetup, completePasswordReset, fetchAuthConfig, signInWithPassword, signInWithPasskey, submitTotpCode, submitRecoveryCode, submitPasskeySecondFactor, startSignInEnrollment, confirmSignInEnrollment, enrollPasskeyInSignIn, requestPasswordReset };
export type AuthFlowActions = typeof authFlowActions;
export type HostedLogin = (options?: { organization?: string }) => Promise<void>;
