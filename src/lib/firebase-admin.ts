import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const projectId =
  (process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || '').trim() ||
  firebaseConfig.projectId;

const databaseId =
  (
    process.env.FIREBASE_FIRESTORE_DATABASE_ID ||
    process.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID ||
    ''
  ).trim() || firebaseConfig.firestoreDatabaseId;

const adminApp = getApps().length
  ? getApps()[0]
  : initializeApp({
      projectId,
    });

const isDefaultDatabase = !databaseId || databaseId === '(default)' || databaseId === 'default';

export const adminAuth = getAuth(adminApp);
export const adminDb = isDefaultDatabase ? getFirestore(adminApp) : getFirestore(adminApp, databaseId);
