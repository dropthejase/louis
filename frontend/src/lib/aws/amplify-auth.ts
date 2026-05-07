import { Amplify } from "aws-amplify";
import {
  signIn as amplifySignIn,
  signUp as amplifySignUp,
  confirmSignUp as amplifyConfirmSignUp,
  signOut as amplifySignOut,
  fetchAuthSession,
  getCurrentUser,
  updateMFAPreference,
  setUpTOTP,
  verifyTOTPSetup,
  type SignInInput,
  type SignUpInput,
} from "aws-amplify/auth";
import { AWS_REGION, USER_POOL_ID, USER_POOL_CLIENT_ID } from "./config";

let configured = false;

export function ensureAmplifyConfigured() {
  if (configured) return;
  configured = true;
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: USER_POOL_ID,
        userPoolClientId: USER_POOL_CLIENT_ID,
      },
    },
  });
}

/** Returns the current Cognito id token string, or throws if not signed in. */
export async function getIdToken(): Promise<string> {
  ensureAmplifyConfigured();
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error("Not authenticated — no Cognito id token");
  return token;
}

export async function signIn(email: string, password: string) {
  ensureAmplifyConfigured();
  return amplifySignIn({ username: email, password });
}

export async function signUp(params: SignUpInput) {
  ensureAmplifyConfigured();
  return amplifySignUp(params);
}

export async function confirmSignUp(username: string, confirmationCode: string) {
  ensureAmplifyConfigured();
  return amplifyConfirmSignUp({ username, confirmationCode });
}

export async function signOut() {
  ensureAmplifyConfigured();
  return amplifySignOut();
}

export async function getCurrentUserId(): Promise<string> {
  ensureAmplifyConfigured();
  const user = await getCurrentUser();
  return user.userId;
}

export { fetchAuthSession, setUpTOTP, verifyTOTPSetup, updateMFAPreference };
