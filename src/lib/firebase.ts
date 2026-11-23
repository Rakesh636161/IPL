import { initializeApp, getApps } from 'firebase/app';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  getAuth,
  inMemoryPersistence,
  setPersistence,
} from 'firebase/auth';
import {
  doc,
  Firestore,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
} from 'firebase/firestore';
import rawFirebaseConfig from '../../firebase-applet-config.json';

const envApiKey = (
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_FIREBASE_API_KEY || ''
    : ''
).trim();

const envAuthDomain = (
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || ''
    : ''
).trim();

const envProjectId = (
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_FIREBASE_PROJECT_ID || ''
    : ''
).trim();

const envStorageBucket = (
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || ''
    : ''
).trim();

const envMessagingSenderId = (
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || ''
    : ''
).trim();

const envAppId = (
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_FIREBASE_APP_ID || ''
    : ''
).trim();

const envDatabaseId = (
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID || ''
    : ''
).trim();

const isPlaceholder = (value: string) => !value || /^REPLACE_WITH_/i.test(value);

const pickConfigValue = (envVal: string, jsonVal: string | undefined, fallback = ''): string => {
  if (!isPlaceholder(envVal)) return envVal;
  const trimmedJson = (jsonVal || '').trim();
  if (!isPlaceholder(trimmedJson)) return trimmedJson;
  return fallback;
};

const resolvedProjectId = pickConfigValue(envProjectId, rawFirebaseConfig.projectId);
const resolvedApiKey = pickConfigValue(envApiKey, rawFirebaseConfig.apiKey);
const resolvedAppId = pickConfigValue(envAppId, rawFirebaseConfig.appId);
const resolvedAuthDomain = pickConfigValue(
  envAuthDomain,
  rawFirebaseConfig.authDomain,
  resolvedProjectId ? `${resolvedProjectId}.firebaseapp.com` : ''
);
const resolvedStorageBucket = pickConfigValue(
  envStorageBucket,
  rawFirebaseConfig.storageBucket,
  resolvedProjectId ? `${resolvedProjectId}.firebasestorage.app` : ''
);
const resolvedMessagingSenderId = pickConfigValue(
  envMessagingSenderId,
  rawFirebaseConfig.messagingSenderId
);
const resolvedDatabaseId = pickConfigValue(
  envDatabaseId,
  rawFirebaseConfig.firestoreDatabaseId,
  '(default)'
);

const missingFields: string[] = [];
if (!resolvedProjectId) missingFields.push('VITE_FIREBASE_PROJECT_ID');
if (!resolvedApiKey) missingFields.push('VITE_FIREBASE_API_KEY');
if (!resolvedAuthDomain) missingFields.push('VITE_FIREBASE_AUTH_DOMAIN');
if (!resolvedAppId) missingFields.push('VITE_FIREBASE_APP_ID');

export const firebaseProjectId = resolvedProjectId;

export const isFirebaseConfigured = missingFields.length === 0;

export const firebaseConfigError = isFirebaseConfigured
  ? null
  : `Missing required Firebase Web App configuration (${missingFields.join(', ')}) for project "${resolvedProjectId || 'unconfigured'}". Configure these VITE_FIREBASE_* environment variables and restart the app.`;

const firebaseConfig = {
  apiKey: resolvedApiKey || 'REPLACE_WITH_API_KEY',
  authDomain: resolvedAuthDomain,
  projectId: resolvedProjectId,
  storageBucket: resolvedStorageBucket,
  messagingSenderId: resolvedMessagingSenderId,
  appId: resolvedAppId,
  ...(rawFirebaseConfig.measurementId ? { measurementId: rawFirebaseConfig.measurementId } : {}),
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = getAuth(app);

let persistenceConfigured = false;
const persistencePromise: Promise<void> = setPersistence(auth, browserLocalPersistence)
  .catch(() => setPersistence(auth, browserSessionPersistence))
  .catch(() => setPersistence(auth, inMemoryPersistence))
  .catch((err) => {
    console.warn('Auth persistence configuration warning:', err);
  })
  .finally(() => {
    persistenceConfigured = true;
  });

export async function ensureAuthPersistence(): Promise<void> {
  if (!persistenceConfigured) {
    await persistencePromise;
  }
}

export async function fallbackToMemoryPersistence(): Promise<void> {
  try {
    await setPersistence(auth, inMemoryPersistence);
  } catch {
    // Ignore if already in memory persistence
  }
}

export function getRuntimeHostname(): string {
  return typeof window !== 'undefined' ? window.location.hostname : '';
}

if (typeof window !== 'undefined') {
  console.info('[Firebase Auth] Runtime configuration:', {
    hostname: window.location.hostname,
    origin: window.location.origin,
    projectId: resolvedProjectId,
    authDomain: resolvedAuthDomain,
    isFirebaseConfigured,
    authMethod: 'email-password',
  });
}

const isDefaultDatabase =
  !resolvedDatabaseId || resolvedDatabaseId === '(default)' || resolvedDatabaseId === 'default';

let firestoreInstance: Firestore;
try {
  firestoreInstance = initializeFirestore(
    app,
    { experimentalAutoDetectLongPolling: true },
    isDefaultDatabase ? undefined : resolvedDatabaseId
  );
} catch {
  firestoreInstance = isDefaultDatabase ? getFirestore(app) : getFirestore(app, resolvedDatabaseId);
}

export const db = firestoreInstance;

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function buildFirestoreErrorInfo(
  error: unknown,
  operationType: OperationType,
  path: string | null
): FirestoreErrorInfo {
  return {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
}

export function isFirestoreOfflineError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    code === 'unavailable' ||
    /client is offline|failed to get document because the client is offline/i.test(message)
  );
}

export function reportFirestoreListenerError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): FirestoreErrorInfo {
  const errInfo = buildFirestoreErrorInfo(error, operationType, path);
  if (isFirestoreOfflineError(error) || !auth.currentUser) {
    console.warn('Firestore Listener Note: ', JSON.stringify(errInfo));
  } else {
    console.error('Firestore Error: ', JSON.stringify(errInfo));
  }
  return errInfo;
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo = buildFirestoreErrorInfo(error, operationType, path);
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

let firestoreOnlineState: boolean | null = null;
let firestoreConnectionPromise: Promise<boolean> | null = null;

export async function testConnection(): Promise<boolean> {
  if (!isFirebaseConfigured) {
    firestoreOnlineState = false;
    return false;
  }
  if (firestoreConnectionPromise) {
    return firestoreConnectionPromise;
  }
  firestoreConnectionPromise = (async () => {
    try {
      await getDocFromServer(doc(db, 'test', 'connection'));
      firestoreOnlineState = true;
      return true;
    } catch (error) {
      if (isFirestoreOfflineError(error)) {
        firestoreOnlineState = false;
        console.warn(
          `Firestore client is offline for project "${resolvedProjectId}". Ensure Cloud Firestore API (firestore.googleapis.com) and the (default) database are enabled in Firebase Console and permitted by VITE_FIREBASE_API_KEY.`
        );
        return false;
      }
      // Permission error proves the Firestore backend responded online
      firestoreOnlineState = true;
      return true;
    } finally {
      firestoreConnectionPromise = null;
    }
  })();
  return firestoreConnectionPromise;
}

export async function ensureFirestoreOnline(): Promise<boolean> {
  if (firestoreOnlineState === true) return true;
  if (firestoreOnlineState === false) return false;
  return await testConnection();
}

void testConnection();

export function mapAuthError(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
  const rawMessage = err instanceof Error ? err.message : String(err ?? '');
  const hostname = getRuntimeHostname() || 'current host';

  if (typeof window !== 'undefined') {
    console.warn('[Firebase Auth] Authentication failure:', {
      code: code || 'unknown',
      message: rawMessage,
      hostname,
      projectId: resolvedProjectId,
      authDomain: resolvedAuthDomain,
    });
  }

  const messages: Record<string, string> = {
    'auth/operation-not-allowed':
      `Email/Password sign-in is disabled on Firebase project "${resolvedProjectId}". Enable Email/Password under Firebase Console -> Authentication -> Sign-in method.`,
    'auth/configuration-not-found':
      `Firebase Authentication is not initialized yet for project "${resolvedProjectId}". Open Firebase Console -> Authentication -> Get started and enable Email/Password.`,
    'auth/invalid-api-key':
      `Invalid Firebase Web API key for project "${resolvedProjectId}". Check VITE_FIREBASE_API_KEY in your environment settings.`,
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.':
      `Invalid Firebase Web API key for project "${resolvedProjectId}". Check VITE_FIREBASE_API_KEY in your environment settings.`,
    'auth/email-already-in-use':
      'An account with this email address already exists. Please sign in instead.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/weak-password': 'Password must be at least 6 characters long.',
    'auth/user-not-found': 'No CricketVerse account was found with this email address.',
    'auth/wrong-password': 'Incorrect password. Please try again or reset your password.',
    'auth/invalid-credential': 'Invalid email or password. Please verify your credentials.',
    'auth/too-many-requests': 'Too many attempts detected. Please wait a moment and try again.',
    'auth/unauthorized-domain':
      `Runtime hostname "${hostname}" is not authorized on Firebase project "${resolvedProjectId}" (authDomain: "${resolvedAuthDomain}"). Add exact hostname "${hostname}" under Firebase Console -> Authentication -> Settings -> Authorized domains.`,
    'auth/operation-not-supported-in-this-environment':
      'Browser storage restrictions prevented sign-in in this view. Enable cookies/site storage or open the app in a full browser tab.',
    'auth/web-storage-unsupported':
      'Browser storage is disabled or blocked. Enable cookies/site storage or open the app in a standalone tab.',
    'auth/user-disabled': 'This account has been disabled in Firebase Authentication.',
    'auth/internal-error':
      'Authentication service encountered an internal error. Verify your Firebase Email/Password provider settings.',
    'auth/network-request-failed': 'Network error connecting to Firebase Authentication.',
  };

  if (code && messages[code]) {
    const suffix = rawMessage ? ` [${code}: ${rawMessage}]` : ` [${code}]`;
    return `${messages[code]}${suffix}`;
  }
  if (code && rawMessage) {
    return `[${code}] ${rawMessage}`;
  }
  return rawMessage || 'Authentication failed.';
}
