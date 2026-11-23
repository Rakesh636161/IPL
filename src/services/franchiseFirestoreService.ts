import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  auth,
  db,
  ensureFirestoreOnline,
  handleFirestoreError,
  isFirestoreOfflineError,
  OperationType,
  reportFirestoreListenerError,
} from '../lib/firebase.ts';

export interface FsFranchise {
  franchiseId: string;
  ownerId: string;
  name: string;
  shortName: string;
  primaryColor: string;
  logoUrl: string | null;
  ownerName: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

function toIso(val: unknown): string {
  if (val instanceof Timestamp) return val.toDate().toISOString();
  if (typeof val === 'string') return val;
  return new Date().toISOString();
}

export async function syncFranchiseCreatedFirestore(params: {
  franchiseId: string;
  ownerUid: string;
  name: string;
  shortName: string;
  primaryColor: string;
  logoUrl?: string | null;
  ownerName: string;
  description?: string;
}) {
  if (!auth.currentUser || auth.currentUser.uid !== params.ownerUid) return;
  if (!(await ensureFirestoreOnline())) return;

  const path = `franchises/${params.franchiseId}`;
  const now = serverTimestamp();

  try {
    await setDoc(doc(db, 'franchises', params.franchiseId), {
      franchiseId: params.franchiseId,
      ownerId: params.ownerUid,
      name: params.name.trim().slice(0, 40),
      shortName: params.shortName.trim().toUpperCase().slice(0, 4),
      primaryColor: params.primaryColor.trim().toUpperCase(),
      logoUrl: params.logoUrl ?? null,
      ownerName: params.ownerName.trim().slice(0, 40),
      description: (params.description || '').trim().slice(0, 240),
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (isFirestoreOfflineError(error) || !auth.currentUser || auth.currentUser.uid !== params.ownerUid) {
      return;
    }
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function syncFranchiseUpdatedFirestore(params: {
  franchiseId: string;
  ownerUid: string;
  name: string;
  shortName: string;
  primaryColor: string;
  logoUrl?: string | null;
  ownerName: string;
  description?: string;
}) {
  if (!auth.currentUser || auth.currentUser.uid !== params.ownerUid) return;
  if (!(await ensureFirestoreOnline())) return;

  const path = `franchises/${params.franchiseId}`;
  try {
    await updateDoc(doc(db, 'franchises', params.franchiseId), {
      name: params.name.trim().slice(0, 40),
      shortName: params.shortName.trim().toUpperCase().slice(0, 4),
      primaryColor: params.primaryColor.trim().toUpperCase(),
      logoUrl: params.logoUrl ?? null,
      ownerName: params.ownerName.trim().slice(0, 40),
      description: (params.description || '').trim().slice(0, 240),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (isFirestoreOfflineError(error) || !auth.currentUser || auth.currentUser.uid !== params.ownerUid) {
      return;
    }
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteFranchiseFirestore(franchiseId: string, ownerUid: string) {
  if (!auth.currentUser || auth.currentUser.uid !== ownerUid) return;
  if (!(await ensureFirestoreOnline())) return;

  const path = `franchises/${franchiseId}`;
  try {
    await deleteDoc(doc(db, 'franchises', franchiseId));
  } catch (error) {
    if (isFirestoreOfflineError(error) || !auth.currentUser || auth.currentUser.uid !== ownerUid) {
      return;
    }
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeToMyFranchisesFirestore(
  ownerUid: string,
  onData: (franchises: FsFranchise[]) => void
) {
  const path = 'franchises';
  const q = query(collection(db, path), where('ownerId', '==', ownerUid));
  return onSnapshot(
    q,
    (snap) => {
      const items: FsFranchise[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            franchiseId: String(data.franchiseId || d.id),
            ownerId: String(data.ownerId || ownerUid),
            name: String(data.name || ''),
            shortName: String(data.shortName || ''),
            primaryColor: String(data.primaryColor || '#F97316'),
            logoUrl: (data.logoUrl as string | null) ?? null,
            ownerName: String(data.ownerName || 'Franchise Owner'),
            description: String(data.description || ''),
            createdAt: toIso(data.createdAt),
            updatedAt: toIso(data.updatedAt),
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onData(items);
    },
    (error) => {
      reportFirestoreListenerError(error, OperationType.LIST, path);
    }
  );
}
