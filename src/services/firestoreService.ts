import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  Timestamp,
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
import { DbUser, UserStatistics } from '../types/cricketverse.ts';

export interface FirestoreUserProfile {
  uid: string;
  uniquePlayerId: string;
  username: string;
  photoUrl: string | null;
  country: string | null;
  bio: string | null;
  preferredRole: string | null;
  onlineStatus: string;
  publicVisible: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface FirestorePlayerDirectoryEntry {
  uid: string;
  uniquePlayerId: string;
  username: string;
  photoUrl: string | null;
  onlineStatus: string;
}

export interface FirestoreAuctionHistoryItem {
  leagueId: string;
  leagueName: string;
  teamName: string;
  teamShortName: string;
  auctionState: string;
  playersWon: number;
  totalSpent: number;
  remainingPurse: number;
  participatedAt: string;
}

export interface FirestoreUserStatistics {
  uid: string;
  totalMatches: number;
  totalWins: number;
  totalTournaments: number;
  auctionsParticipated: number;
  playersAcquired: number;
  totalSpent: number;
  auctionHistory: FirestoreAuctionHistoryItem[];
}

export interface FirestoreFriendRequestDoc {
  id: string;
  senderId: string;
  senderPlayerId: string;
  senderUsername: string;
  senderPhotoUrl?: string | null;
  receiverId: string;
  receiverPlayerId: string;
  receiverUsername: string;
  receiverPhotoUrl?: string | null;
  participants: string[];
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  createdAt?: string;
}

export interface FirestoreNotificationDoc {
  id: string;
  userId: string;
  senderId: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  metadata?: Record<string, string> | null;
  createdAt: string;
}

function toIso(val: unknown): string {
  if (val instanceof Timestamp) return val.toDate().toISOString();
  if (typeof val === 'string') return val;
  return new Date().toISOString();
}

export function pairDocId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join('__');
}

/**
 * Ensures the authenticated user's Firestore documents exist in
 * /users/{uid}, /user_profiles/{uid}, /player_directory/{uniquePlayerId}, and /user_statistics/{uid}.
 */
export async function ensureFirestoreUserDocs(dbUser: DbUser): Promise<string | null> {
  if (!dbUser.uid || !dbUser.profile?.uniquePlayerId) return null;

  const uid = dbUser.uid;
  if (!auth.currentUser || auth.currentUser.uid !== uid) return null;
  if (!(await ensureFirestoreOnline())) return null;

  const playerId = dbUser.profile.uniquePlayerId;
  const cleanName = (dbUser.profile.displayName || 'Franchise Owner').trim().slice(0, 40);
  const rawPhoto = dbUser.profile.avatarUrl || null;
  const photoUrl = rawPhoto && rawPhoto.length <= 500 ? rawPhoto : null;

  const userRef = doc(db, 'users', uid);
  const profileRef = doc(db, 'user_profiles', uid);
  const statsRef = doc(db, 'user_statistics', uid);

  try {
    const [userSnap, profileSnap, statsSnap] = await Promise.all([
      getDoc(userRef),
      getDoc(profileRef),
      getDoc(statsRef),
    ]);

    const existingUserCode = userSnap.exists() ? String(userSnap.data().uniquePlayerId || '') : '';
    const existingProfileCode = profileSnap.exists()
      ? String(profileSnap.data().uniquePlayerId || '')
      : '';

    // Never generate Player IDs on the client: preserve any immutable existing Firestore ID
    // or persist the authoritative server-generated CV Player ID from /api/me.
    const permanentPlayerId = existingUserCode || existingProfileCode || playerId;
    if (!/^CV[0-9]{6,}$/.test(permanentPlayerId)) {
      return null;
    }

    const dirRef = doc(db, 'player_directory', permanentPlayerId);
    const dirSnap = await getDoc(dirRef);
    const dirOwnedByOther = dirSnap.exists() && String(dirSnap.data().uid || '') !== uid;

    const batch = writeBatch(db);
    let hasWrites = false;
    const now = serverTimestamp();

    if (!userSnap.exists()) {
      batch.set(userRef, {
        uid,
        email: dbUser.email || `${uid}@cricketverse.app`,
        uniquePlayerId: permanentPlayerId,
        role: 'USER',
        createdAt: now,
        updatedAt: now,
      });
      hasWrites = true;
    }

    if (!profileSnap.exists()) {
      batch.set(profileRef, {
        uid,
        uniquePlayerId: permanentPlayerId,
        username: cleanName.length >= 2 ? cleanName : 'Franchise Owner',
        photoUrl,
        country: (dbUser.profile.country || 'Global').slice(0, 40),
        bio: (dbUser.profile.bio || 'Franchise Owner').slice(0, 160),
        preferredRole: (dbUser.profile.preferredRole || 'Tactician').slice(0, 40),
        onlineStatus: 'ONLINE',
        publicVisible: true,
        createdAt: now,
        updatedAt: now,
      });
      hasWrites = true;
    } else if (profileSnap.data().onlineStatus !== 'ONLINE') {
      batch.update(profileRef, {
        onlineStatus: 'ONLINE',
        updatedAt: now,
      });
      hasWrites = true;
    }

    if (!dirOwnedByOther) {
      if (!dirSnap.exists()) {
        batch.set(dirRef, {
          uid,
          uniquePlayerId: permanentPlayerId,
          username: cleanName.length >= 2 ? cleanName : 'Franchise Owner',
          photoUrl,
          onlineStatus: 'ONLINE',
          updatedAt: now,
        });
        hasWrites = true;
      } else if (dirSnap.data().onlineStatus !== 'ONLINE') {
        batch.update(dirRef, {
          onlineStatus: 'ONLINE',
          updatedAt: now,
        });
        hasWrites = true;
      }
    } else {
      console.warn(
        `Player directory ID "${permanentPlayerId}" is already claimed by another user; skipping directory write.`
      );
    }

    if (!statsSnap.exists()) {
      batch.set(statsRef, {
        uid,
        totalMatches: 0,
        totalWins: 0,
        totalTournaments: 0,
        auctionsParticipated: 0,
        playersAcquired: 0,
        totalSpent: 0,
        auctionHistory: [],
        updatedAt: now,
      });
      hasWrites = true;
    }

    if (hasWrites) {
      await batch.commit();
    }

    return permanentPlayerId;
  } catch (error) {
    if (isFirestoreOfflineError(error) || !auth.currentUser || auth.currentUser.uid !== uid) {
      console.warn(
        `Skipped Firestore user sync for "${uid}" (${isFirestoreOfflineError(error) ? 'Firestore offline/disabled' : 'session signed out'}).`
      );
      return null;
    }
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}`);
  }
}

export function subscribeToUserProfile(
  uid: string,
  onData: (profile: FirestoreUserProfile | null) => void
) {
  const path = `user_profiles/${uid}`;
  return onSnapshot(
    doc(db, 'user_profiles', uid),
    (snap) => {
      if (!snap.exists()) {
        onData(null);
        return;
      }
      const d = snap.data();
      onData({
        uid: String(d.uid || uid),
        uniquePlayerId: String(d.uniquePlayerId || ''),
        username: String(d.username || 'Franchise Owner'),
        photoUrl: (d.photoUrl as string | null) ?? null,
        country: (d.country as string | null) ?? 'Global',
        bio: (d.bio as string | null) ?? 'Franchise Owner',
        preferredRole: (d.preferredRole as string | null) ?? 'Tactician',
        onlineStatus: String(d.onlineStatus || 'ONLINE'),
        publicVisible: Boolean(d.publicVisible ?? true),
        createdAt: d.createdAt ? toIso(d.createdAt) : undefined,
        updatedAt: d.updatedAt ? toIso(d.updatedAt) : undefined,
      });
    },
    (error) => {
      reportFirestoreListenerError(error, OperationType.GET, path);
    }
  );
}

export function subscribeToUserStatistics(
  uid: string,
  onData: (stats: FirestoreUserStatistics | null) => void
) {
  const path = `user_statistics/${uid}`;
  return onSnapshot(
    doc(db, 'user_statistics', uid),
    (snap) => {
      if (!snap.exists()) {
        onData(null);
        return;
      }
      const d = snap.data();
      onData({
        uid: String(d.uid || uid),
        totalMatches: Number(d.totalMatches || 0),
        totalWins: Number(d.totalWins || 0),
        totalTournaments: Number(d.totalTournaments || 0),
        auctionsParticipated: Number(d.auctionsParticipated || 0),
        playersAcquired: Number(d.playersAcquired || 0),
        totalSpent: Number(d.totalSpent || 0),
        auctionHistory: Array.isArray(d.auctionHistory) ? d.auctionHistory : [],
      });
    },
    (error) => {
      reportFirestoreListenerError(error, OperationType.GET, path);
    }
  );
}

export async function syncUserStatisticsInFirestore(uid: string, stats: UserStatistics) {
  if (!auth.currentUser || auth.currentUser.uid !== uid) return;
  if (!(await ensureFirestoreOnline())) return;
  const path = `user_statistics/${uid}`;
  try {
    await setDoc(doc(db, 'user_statistics', uid), {
      uid,
      totalMatches: Math.max(0, Math.trunc(stats.totalMatches)),
      totalWins: Math.max(0, Math.trunc(stats.totalWins)),
      totalTournaments: Math.max(0, Math.trunc(stats.totalTournaments)),
      auctionsParticipated: Math.max(0, Math.trunc(stats.auctionsParticipated)),
      playersAcquired: Math.max(0, Math.trunc(stats.playersAcquired)),
      totalSpent: Math.max(0, Math.trunc(stats.totalSpent)),
      auctionHistory: (stats.auctionHistory || []).slice(0, 25),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (isFirestoreOfflineError(error) || !auth.currentUser || auth.currentUser.uid !== uid) {
      return;
    }
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeToNotifications(
  uid: string,
  onData: (items: FirestoreNotificationDoc[]) => void
) {
  const path = 'notifications';
  const q = query(collection(db, path), where('userId', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const list: FirestoreNotificationDoc[] = snap.docs
        .map((docSnap) => {
          const d = docSnap.data();
          return {
            id: docSnap.id,
            userId: String(d.userId || uid),
            senderId: String(d.senderId || ''),
            type: String(d.type || 'SYSTEM'),
            title: String(d.title || 'Alert'),
            message: String(d.message || ''),
            read: Boolean(d.read),
            metadata: (d.metadata as Record<string, string> | null) ?? null,
            createdAt: toIso(d.createdAt),
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 25);
      onData(list);
    },
    (error) => {
      reportFirestoreListenerError(error, OperationType.LIST, path);
    }
  );
}

export async function markFirestoreNotificationRead(notificationId: string) {
  const path = `notifications/${notificationId}`;
  try {
    await updateDoc(doc(db, 'notifications', notificationId), { read: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function lookupPlayerByUniqueIdFirestore(
  uniquePlayerId: string
): Promise<FirestorePlayerDirectoryEntry | null> {
  const normalized = uniquePlayerId.trim().toUpperCase();
  if (!/^CV[0-9]{6,}$/.test(normalized)) {
    return null;
  }
  const path = `player_directory/${normalized}`;
  try {
    const snap = await getDoc(doc(db, 'player_directory', normalized));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      uid: String(d.uid),
      uniquePlayerId: String(d.uniquePlayerId),
      username: String(d.username || 'Franchise Owner'),
      photoUrl: (d.photoUrl as string | null) ?? null,
      onlineStatus: String(d.onlineStatus || 'ONLINE'),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function updateProfileInFirestore(
  uid: string,
  uniquePlayerId: string,
  updates: {
    username: string;
    photoUrl: string | null;
    country?: string;
    bio?: string;
    preferredRole?: string;
  }
) {
  if (!auth.currentUser || auth.currentUser.uid !== uid) return;
  if (!(await ensureFirestoreOnline())) return;

  const cleanName = updates.username.trim().slice(0, 40);
  const profileRef = doc(db, 'user_profiles', uid);
  const directoryRef = doc(db, 'player_directory', uniquePlayerId);
  const path = `user_profiles/${uid}`;

  try {
    const [profileSnap, dirSnap] = await Promise.all([
      getDoc(profileRef),
      /^CV[0-9]{6,}$/.test(uniquePlayerId) ? getDoc(directoryRef) : Promise.resolve(null),
    ]);

    const batch = writeBatch(db);
    const now = serverTimestamp();

    if (!profileSnap.exists()) {
      batch.set(profileRef, {
        uid,
        uniquePlayerId,
        username: cleanName,
        photoUrl: updates.photoUrl ?? null,
        country: (updates.country || 'Global').trim().slice(0, 40),
        bio: (updates.bio || 'Franchise Owner').trim().slice(0, 160),
        preferredRole: (updates.preferredRole || 'Tactician').trim().slice(0, 40),
        onlineStatus: 'ONLINE',
        publicVisible: true,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      batch.update(profileRef, {
        username: cleanName,
        photoUrl: updates.photoUrl ?? null,
        ...(updates.country !== undefined
          ? { country: (updates.country.trim() || 'Global').slice(0, 40) }
          : {}),
        ...(updates.bio !== undefined
          ? { bio: (updates.bio.trim() || 'Franchise Owner').slice(0, 160) }
          : {}),
        ...(updates.preferredRole !== undefined
          ? { preferredRole: (updates.preferredRole.trim() || 'Tactician').slice(0, 40) }
          : {}),
        updatedAt: now,
      });
    }

    if (/^CV[0-9]{6,}$/.test(uniquePlayerId)) {
      if (!dirSnap || !dirSnap.exists()) {
        batch.set(directoryRef, {
          uid,
          uniquePlayerId,
          username: cleanName,
          photoUrl: updates.photoUrl ?? null,
          onlineStatus: 'ONLINE',
          updatedAt: now,
        });
      } else if (String(dirSnap.data().uid || '') === uid) {
        batch.update(directoryRef, {
          username: cleanName,
          photoUrl: updates.photoUrl ?? null,
          updatedAt: now,
        });
      }
    }

    await batch.commit();
  } catch (error) {
    if (isFirestoreOfflineError(error) || !auth.currentUser || auth.currentUser.uid !== uid) {
      return;
    }
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function setOfflineStatusFirestore(uid: string, uniquePlayerId?: string | null) {
  const path = `user_profiles/${uid}`;
  if (!auth.currentUser || auth.currentUser.uid !== uid) return;
  if (!(await ensureFirestoreOnline())) return;
  try {
    const profileRef = doc(db, 'user_profiles', uid);
    const snap = await getDoc(profileRef);
    if (!snap.exists()) return;
    if (!auth.currentUser || auth.currentUser.uid !== uid) return;
    const batch = writeBatch(db);
    const now = serverTimestamp();
    batch.update(profileRef, { onlineStatus: 'OFFLINE', updatedAt: now });
    if (uniquePlayerId && /^CV[0-9]{6,}$/.test(uniquePlayerId)) {
      const dirRef = doc(db, 'player_directory', uniquePlayerId);
      const dirSnap = await getDoc(dirRef);
      if (dirSnap.exists()) {
        batch.update(dirRef, { onlineStatus: 'OFFLINE', updatedAt: now });
      }
    }
    await batch.commit();
  } catch (error) {
    if (isFirestoreOfflineError(error) || !auth.currentUser || auth.currentUser.uid !== uid) {
      return;
    }
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function sendFriendRequestFirestore(params: {
  senderUid: string;
  senderPlayerId: string;
  senderUsername: string;
  senderPhotoUrl: string | null;
  receiverPlayerId: string;
}) {
  if (!auth.currentUser || auth.currentUser.uid !== params.senderUid) return;
  if (!(await ensureFirestoreOnline())) return;

  const receiver = await lookupPlayerByUniqueIdFirestore(params.receiverPlayerId);
  if (!receiver) return;
  if (receiver.uid === params.senderUid) return;

  const pairId = pairDocId(params.senderUid, receiver.uid);
  const reqRef = doc(db, 'friend_requests', pairId);
  const camelReqRef = doc(db, 'friendRequests', pairId);
  const path = `friendRequests/${pairId}`;

  try {
    const existingSnap = await getDoc(reqRef);
    if (existingSnap.exists()) {
      const status = existingSnap.data().status;
      if (status === 'PENDING' || status === 'ACCEPTED') {
        return;
      }
      const cleanBatch = writeBatch(db);
      cleanBatch.delete(reqRef);
      cleanBatch.delete(camelReqRef);
      await cleanBatch.commit();
    }

    const batch = writeBatch(db);
    const now = serverTimestamp();
    const requestPayload = {
      senderId: params.senderUid,
      senderPlayerId: params.senderPlayerId,
      senderUsername: params.senderUsername.slice(0, 40),
      senderPhotoUrl: params.senderPhotoUrl ?? null,
      receiverId: receiver.uid,
      receiverPlayerId: receiver.uniquePlayerId,
      receiverUsername: receiver.username.slice(0, 40),
      receiverPhotoUrl: receiver.photoUrl ?? null,
      participants: [params.senderUid, receiver.uid],
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    };
    batch.set(reqRef, requestPayload);
    batch.set(camelReqRef, requestPayload);
    batch.set(doc(collection(db, 'notifications')), {
      userId: receiver.uid,
      senderId: params.senderUid,
      type: 'FRIEND_REQUEST',
      title: 'New Friend Request',
      message: `${params.senderUsername} (${params.senderPlayerId}) sent you a friend request.`,
      read: false,
      metadata: { pairId, senderPlayerId: params.senderPlayerId },
      createdAt: now,
    });
    await batch.commit();
  } catch (error) {
    if (isFirestoreOfflineError(error)) return;
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function respondToFriendRequestFirestore(params: {
  currentUid: string;
  currentUsername: string;
  currentPlayerId: string;
  otherPlayerId: string;
  action: 'ACCEPT' | 'REJECT';
}) {
  if (!auth.currentUser || auth.currentUser.uid !== params.currentUid) return;
  if (!(await ensureFirestoreOnline())) return;

  const other = await lookupPlayerByUniqueIdFirestore(params.otherPlayerId);
  if (!other) return;

  const pairId = pairDocId(params.currentUid, other.uid);
  const reqRef = doc(db, 'friend_requests', pairId);
  const camelReqRef = doc(db, 'friendRequests', pairId);
  const friendRef = doc(db, 'friends', pairId);
  const camelFriendRef = doc(db, 'friendships', pairId);
  const path = `friendRequests/${pairId}`;

  try {
    const [reqSnap, camelReqSnap] = await Promise.all([getDoc(reqRef), getDoc(camelReqRef)]);
    if (!reqSnap.exists()) return;
    if (reqSnap.data().status !== 'PENDING' || reqSnap.data().receiverId !== params.currentUid) {
      return;
    }

    const batch = writeBatch(db);
    const now = serverTimestamp();
    const nextStatus = params.action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
    batch.update(reqRef, { status: nextStatus, updatedAt: now });
    if (camelReqSnap.exists() && camelReqSnap.data().status === 'PENDING') {
      batch.update(camelReqRef, { status: nextStatus, updatedAt: now });
    }

    if (params.action === 'ACCEPT') {
      const [u1, u2] = [params.currentUid, other.uid].sort();
      const friendshipPayload = {
        user1Id: u1,
        user2Id: u2,
        participants: [u1, u2],
        createdBy: params.currentUid,
        createdAt: now,
      };
      batch.set(friendRef, friendshipPayload);
      batch.set(camelFriendRef, friendshipPayload);
      batch.set(doc(collection(db, 'notifications')), {
        userId: other.uid,
        senderId: params.currentUid,
        type: 'FRIEND_ACCEPTED',
        title: 'Friend Request Accepted',
        message: `${params.currentUsername} (${params.currentPlayerId}) accepted your friend request.`,
        read: false,
        metadata: { pairId },
        createdAt: now,
      });
    }

    await batch.commit();
  } catch (error) {
    if (isFirestoreOfflineError(error)) return;
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function removeFriendFirestore(currentUid: string, otherPlayerId: string) {
  if (!auth.currentUser || auth.currentUser.uid !== currentUid) return;
  if (!(await ensureFirestoreOnline())) return;

  const other = await lookupPlayerByUniqueIdFirestore(otherPlayerId);
  if (!other) return;
  const pairId = pairDocId(currentUid, other.uid);
  const path = `friendships/${pairId}`;

  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'friends', pairId));
    batch.delete(doc(db, 'friendships', pairId));
    batch.delete(doc(db, 'friend_requests', pairId));
    batch.delete(doc(db, 'friendRequests', pairId));
    await batch.commit();
  } catch (error) {
    if (isFirestoreOfflineError(error)) return;
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeToFriendRequestsFirestore(
  uid: string,
  onData: (requests: FirestoreFriendRequestDoc[]) => void
) {
  const path = 'friend_requests';
  const q = query(collection(db, path), where('participants', 'array-contains', uid));
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          senderId: String(data.senderId),
          senderPlayerId: String(data.senderPlayerId),
          senderUsername: String(data.senderUsername),
          senderPhotoUrl: (data.senderPhotoUrl as string | null) ?? null,
          receiverId: String(data.receiverId),
          receiverPlayerId: String(data.receiverPlayerId),
          receiverUsername: String(data.receiverUsername),
          receiverPhotoUrl: (data.receiverPhotoUrl as string | null) ?? null,
          participants: Array.isArray(data.participants) ? data.participants.map(String) : [],
          status: data.status as 'PENDING' | 'ACCEPTED' | 'REJECTED',
          createdAt: data.createdAt ? toIso(data.createdAt) : undefined,
        };
      });
      onData(list);
    },
    (error) => {
      reportFirestoreListenerError(error, OperationType.LIST, path);
    }
  );
}
