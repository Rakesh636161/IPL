import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'firebase/auth';
import {
  auth,
  ensureAuthPersistence,
  fallbackToMemoryPersistence,
  firebaseConfigError,
  isFirebaseConfigured,
  mapAuthError,
} from '../lib/firebase.ts';
import {
  ensureFirestoreUserDocs,
  FirestoreNotificationDoc,
  FirestoreUserProfile,
  FirestoreUserStatistics,
  markFirestoreNotificationRead,
  setOfflineStatusFirestore,
  subscribeToNotifications,
  subscribeToUserProfile,
  subscribeToUserStatistics,
  updateProfileInFirestore,
} from '../services/firestoreService.ts';
import { DbUser, NotificationItem } from '../types/cricketverse.ts';

export interface ProfileUpdateInput {
  displayName: string;
  avatarUrl?: string | null;
  country?: string;
  bio?: string;
  preferredRole?: string;
}

interface AuthContextValue {
  firebaseUser: User | null;
  dbUser: DbUser | null;
  firestoreProfile: FirestoreUserProfile | null;
  firestoreStats: FirestoreUserStatistics | null;
  notifications: NotificationItem[];
  loading: boolean;
  authReady: boolean;
  authError: string | null;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (email: string, password: string, displayName: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  sendVerificationEmail: () => Promise<void>;
  updateUserProfile: (updates: ProfileUpdateInput) => Promise<void>;
  markNotificationRead: (id: string) => Promise<void>;
  logout: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
  apiFetch: <T = unknown>(url: string, init?: RequestInit) => Promise<T>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [dbUser, setDbUser] = useState<DbUser | null>(null);
  const [firestoreProfile, setFirestoreProfile] = useState<FirestoreUserProfile | null>(null);
  const [firestoreStats, setFirestoreStats] = useState<FirestoreUserStatistics | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const registrationInProgressRef = useRef(false);

  const getIdToken = useCallback(async (forceRefresh = false) => {
    const current = auth.currentUser;
    if (!current) return null;
    return await current.getIdToken(forceRefresh);
  }, []);

  const apiFetch = useCallback(
    async <T = unknown>(url: string, init?: RequestInit): Promise<T> => {
      const executeFetch = async (forceRefresh: boolean) => {
        const token = await getIdToken(forceRefresh);
        if (!token) throw new Error('Not authenticated');
        const headers = new Headers(init?.headers || {});
        headers.set('Authorization', `Bearer ${token}`);
        if (init?.body && !headers.has('Content-Type')) {
          headers.set('Content-Type', 'application/json');
        }
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 15000);
        try {
          const res = await fetch(url, {
            ...init,
            headers,
            signal: init?.signal ?? controller.signal,
          });
          return res;
        } finally {
          window.clearTimeout(timeoutId);
        }
      };

      try {
        let res = await executeFetch(false);
        if (res.status === 401 && auth.currentUser) {
          res = await executeFetch(true);
        }
        const contentType = res.headers.get('content-type') || '';
        const isJson = contentType.includes('application/json');
        const data = isJson ? await res.json().catch(() => ({})) : {};
        if (!res.ok) {
          throw new Error(
            (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error) ||
              `Request failed (${res.status})`
          );
        }
        if (url.startsWith('/api/') && !isJson) {
          throw new Error(`Unexpected non-JSON response from ${url}. Please refresh and try again.`);
        }
        return data as T;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new Error('Server request timed out. Please retry.');
        }
        throw err;
      }
    },
    [getIdToken]
  );

  const refreshSession = useCallback(async () => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    const run = async () => {
      if (!auth.currentUser) {
        setDbUser(null);
        setFirestoreProfile(null);
        setFirestoreStats(null);
        setNotifications([]);
        return;
      }
      try {
        const data = await apiFetch<{ user: DbUser; notifications: NotificationItem[] }>('/api/me');
        setDbUser(data.user);
        setNotifications(data.notifications || []);
        setAuthError(null);
        void ensureFirestoreUserDocs(data.user)
          .then((permanentId) => {
            if (
              permanentId &&
              data.user.profile &&
              permanentId !== data.user.profile.uniquePlayerId
            ) {
              setDbUser((prev) =>
                prev && prev.profile
                  ? { ...prev, profile: { ...prev.profile, uniquePlayerId: permanentId } }
                  : prev
              );
            }
          })
          .catch((fsErr) => {
            console.warn('Firestore user bootstrap note:', fsErr);
          });
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : 'Failed to load profile');
      }
    };

    const p = run().finally(() => {
      if (refreshPromiseRef.current === p) {
        refreshPromiseRef.current = null;
      }
    });
    refreshPromiseRef.current = p;
    return p;
  }, [apiFetch]);

  useEffect(() => {
    let active = true;
    const safetyTimer = window.setTimeout(() => {
      if (active) {
        setAuthReady(true);
        setLoading(false);
      }
    }, 10000);

    const persistenceReady = ensureAuthPersistence().catch(() => undefined);

    const unsub = onAuthStateChanged(
      auth,
      async (user) => {
        await persistenceReady;
        if (!active) return;
        try {
          setFirebaseUser(user);
          if (user) {
            if (!registrationInProgressRef.current) {
              await refreshSession();
            }
          } else {
            setDbUser(null);
            setFirestoreProfile(null);
            setFirestoreStats(null);
            setNotifications([]);
          }
        } finally {
          window.clearTimeout(safetyTimer);
          if (active) {
            setAuthReady(true);
            setLoading(false);
          }
        }
      },
      (err) => {
        window.clearTimeout(safetyTimer);
        if (active) {
          setAuthError(mapAuthError(err));
          setAuthReady(true);
          setLoading(false);
        }
      }
    );
    return () => {
      active = false;
      window.clearTimeout(safetyTimer);
      unsub();
    };
  }, [refreshSession]);

  // Attach Firestore real-time listeners only after auth is ready & dbUser is bootstrapped
  useEffect(() => {
    if (!authReady || !firebaseUser || !dbUser) return;

    const unsubProfile = subscribeToUserProfile(firebaseUser.uid, (prof) => {
      if (prof) {
        setFirestoreProfile(prof);
        setDbUser((prev) =>
          prev && prev.profile
            ? {
                ...prev,
                profile: {
                  ...prev.profile,
                  uniquePlayerId: prof.uniquePlayerId || prev.profile.uniquePlayerId,
                  displayName: prof.username || prev.profile.displayName,
                  avatarUrl: prof.photoUrl ?? prev.profile.avatarUrl,
                  country: prof.country ?? prev.profile.country,
                  bio: prof.bio ?? prev.profile.bio,
                  preferredRole: prof.preferredRole ?? prev.profile.preferredRole,
                  onlineStatus: prof.onlineStatus || prev.profile.onlineStatus,
                },
              }
            : prev
        );
      }
    });

    const unsubStats = subscribeToUserStatistics(firebaseUser.uid, (stats) => {
      if (stats) setFirestoreStats(stats);
    });

    const unsubNotifs = subscribeToNotifications(
      firebaseUser.uid,
      (fsNotifs: FirestoreNotificationDoc[]) => {
        if (fsNotifs.length > 0) {
          setNotifications((prev) => {
            const existingIds = new Set(prev.map((n) => n.id));
            const mapped: NotificationItem[] = fsNotifs.map((n) => ({
              id: n.id,
              type: n.type,
              title: n.title,
              message: n.message,
              metadata: n.metadata ?? null,
              isRead: n.read,
              createdAt: n.createdAt,
            }));
            const merged = [...mapped];
            for (const p of prev) {
              if (!merged.some((m) => m.id === p.id) && existingIds.has(p.id)) {
                merged.push(p);
              }
            }
            return merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25);
          });
        }
      }
    );

    return () => {
      unsubProfile();
      unsubStats();
      unsubNotifs();
    };
  }, [authReady, firebaseUser?.uid, dbUser?.id]);

  const runWithPersistenceFallback = async <T,>(fn: () => Promise<T>): Promise<T> => {
    await ensureAuthPersistence();
    try {
      return await fn();
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (
        code === 'auth/web-storage-unsupported' ||
        code === 'auth/operation-not-supported-in-this-environment'
      ) {
        await fallbackToMemoryPersistence();
        return await fn();
      }
      throw err;
    }
  };

  const signInWithEmail = async (email: string, password: string) => {
    setAuthError(null);
    if (!isFirebaseConfigured) {
      const msg = firebaseConfigError || 'Firebase configuration is incomplete.';
      setAuthError(msg);
      throw new Error(msg);
    }
    try {
      await runWithPersistenceFallback(() =>
        signInWithEmailAndPassword(auth, email.trim(), password)
      );
      await refreshSession();
    } catch (err) {
      const message = mapAuthError(err);
      setAuthError(message);
      throw new Error(message);
    }
  };

  const registerWithEmail = async (email: string, password: string, displayName: string) => {
    setAuthError(null);
    if (!isFirebaseConfigured) {
      const msg = firebaseConfigError || 'Firebase configuration is incomplete.';
      setAuthError(msg);
      throw new Error(msg);
    }
    registrationInProgressRef.current = true;
    try {
      const trimmedName = displayName.trim();
      const cred = await runWithPersistenceFallback(() =>
        createUserWithEmailAndPassword(auth, email.trim(), password)
      );
      if (trimmedName) {
        await updateProfile(cred.user, { displayName: trimmedName });
        // Force-refresh token so backend verifyIdToken receives the updated displayName claim
        await cred.user.getIdToken(true);
      }
      setFirebaseUser(cred.user);
      await refreshSession();
    } catch (err) {
      const message = mapAuthError(err);
      setAuthError(message);
      throw new Error(message);
    } finally {
      registrationInProgressRef.current = false;
    }
  };

  const resetPassword = async (email: string) => {
    setAuthError(null);
    if (!isFirebaseConfigured) {
      const msg = firebaseConfigError || 'Firebase configuration is incomplete.';
      setAuthError(msg);
      throw new Error(msg);
    }
    try {
      await ensureAuthPersistence();
      await sendPasswordResetEmail(auth, email.trim());
    } catch (err) {
      const message = mapAuthError(err);
      setAuthError(message);
      throw new Error(message);
    }
  };

  const sendVerificationEmail = async () => {
    if (!auth.currentUser) throw new Error('Not authenticated');
    await sendEmailVerification(auth.currentUser);
  };

  const updateUserProfile = async (updates: ProfileUpdateInput) => {
    if (!auth.currentUser) throw new Error('Not authenticated');
    await apiFetch('/api/me/profile', {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });

    const uniquePlayerId =
      firestoreProfile?.uniquePlayerId || dbUser?.profile?.uniquePlayerId || '';
    if (uniquePlayerId) {
      await updateProfileInFirestore(auth.currentUser.uid, uniquePlayerId, {
        username: updates.displayName,
        photoUrl:
          updates.avatarUrl !== undefined
            ? updates.avatarUrl
            : dbUser?.profile?.avatarUrl ?? null,
        country: updates.country,
        bio: updates.bio,
        preferredRole: updates.preferredRole,
      });
    }

    try {
      await updateProfile(auth.currentUser, {
        displayName: updates.displayName.trim(),
        ...(updates.avatarUrl !== undefined ? { photoURL: updates.avatarUrl || '' } : {}),
      });
    } catch {
      // non-fatal Auth metadata mirror
    }
    await refreshSession();
  };

  const markNotificationRead = async (id: string) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
    } catch {
      await markFirestoreNotificationRead(id);
    }
    await refreshSession();
  };

  const logout = async () => {
    try {
      if (auth.currentUser) {
        const uid = auth.currentUser.uid;
        const playerId = firestoreProfile?.uniquePlayerId || dbUser?.profile?.uniquePlayerId;
        await Promise.race([
          Promise.allSettled([
            apiFetch('/api/me/offline', { method: 'POST' }),
            setOfflineStatusFirestore(uid, playerId),
          ]),
          new Promise<void>((resolve) => window.setTimeout(resolve, 800)),
        ]);
      }
    } catch {
      // Best-effort offline status update should never block signOut
    } finally {
      await signOut(auth);
      setFirebaseUser(null);
      setDbUser(null);
      setFirestoreProfile(null);
      setFirestoreStats(null);
      setNotifications([]);
      setAuthError(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        dbUser,
        firestoreProfile,
        firestoreStats,
        notifications,
        loading,
        authReady,
        authError,
        signInWithEmail,
        registerWithEmail,
        resetPassword,
        sendVerificationEmail,
        updateUserProfile,
        markNotificationRead,
        logout,
        getIdToken,
        apiFetch,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
