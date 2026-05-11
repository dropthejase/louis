// Amplify is configured once at app startup in App.tsx — no lazy init needed here.
import {
  signOut as amplifySignOut,
  fetchAuthSession,
  getCurrentUser,
} from 'aws-amplify/auth';

export async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error('Not authenticated — no Cognito id token');
  return token;
}

export async function signOut() {
  return amplifySignOut();
}

export async function getCurrentUserId(): Promise<string> {
  const user = await getCurrentUser();
  return user.userId;
}

export { fetchAuthSession };
