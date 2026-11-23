import { Request, Response, NextFunction } from 'express';
import { DecodedIdToken } from 'firebase-admin/auth';
import { eq, sql } from 'drizzle-orm';
import { adminAuth } from '../../src/lib/firebase-admin.ts';
import { db } from '../../src/db/index.ts';
import { realtimeCache, userProfiles, users } from '../../src/db/schema.ts';
import { logEvent } from '../lib/logger.ts';

export interface DbUserRecord {
  id: string;
  uid: string;
  email: string;
  role: string;
  createdAt?: string;
  profile: {
    id: string;
    uniquePlayerId: string;
    displayName: string;
    avatarUrl: string | null;
    country: string | null;
    bio: string | null;
    preferredRole: string | null;
    onlineStatus: string;
  } | null;
}

export interface AuthRequest extends Request {
  firebaseUser?: DecodedIdToken;
  dbUser?: DbUserRecord;
}

const SEQUENTIAL_ID_REGEX = /^CV\d{6,}$/;

async function nextPostgresSequencePlayerId(): Promise<string> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(918273645)`);
    const [counter] = await tx
      .select()
      .from(realtimeCache)
      .where(eq(realtimeCache.cacheKey, 'system:cv_player_id_counter'))
      .limit(1);

    let nextNum: number;
    if (counter && typeof (counter.value as { nextNumber?: unknown })?.nextNumber === 'number') {
      nextNum = (counter.value as { nextNumber: number }).nextNumber;
    } else {
      const existingMaxRes = await tx.execute(
        sql`SELECT COALESCE(MAX(SUBSTRING(unique_player_id FROM 3)::bigint), 100000) AS max_num
            FROM user_profiles
            WHERE unique_player_id ~ '^CV[0-9]{6,}$'`
      );
      const maxNum = Number(
        (existingMaxRes.rows[0] as { max_num?: string | number } | undefined)?.max_num ?? 100000
      );
      nextNum = Math.max(100001, maxNum + 1);
    }

    await tx
      .insert(realtimeCache)
      .values({
        cacheKey: 'system:cv_player_id_counter',
        value: { nextNumber: nextNum + 1 },
        expiresAt: new Date('2099-12-31T23:59:59.000Z'),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: realtimeCache.cacheKey,
        set: {
          value: { nextNumber: nextNum + 1 },
          expiresAt: new Date('2099-12-31T23:59:59.000Z'),
          updatedAt: new Date(),
        },
      });

    return `CV${nextNum}`;
  });
}

async function ensureSequentialPlayerId(
  existingPgPlayerId?: string | null
): Promise<string> {
  if (existingPgPlayerId && SEQUENTIAL_ID_REGEX.test(existingPgPlayerId)) {
    return existingPgPlayerId;
  }
  return await nextPostgresSequencePlayerId();
}

export async function getOrCreateDbUser(
  uid: string,
  email: string,
  displayName?: string,
  avatarUrl?: string | null
): Promise<DbUserRecord> {
  try {
    const cleanEmail = (email || `${uid}@cricketverse.app`).trim();
    const isDesignatedAdmin = cleanEmail.toLowerCase() === 'sandugoudar663@gmail.com';

    const [upsertedUser] = await db
      .insert(users)
      .values({
        uid,
        email: cleanEmail,
        role: isDesignatedAdmin ? 'ADMIN' : 'USER',
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email: cleanEmail,
          ...(isDesignatedAdmin ? { role: 'ADMIN' } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();

    const existingProfiles = await db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, upsertedUser.id))
      .limit(1);

    let profile = existingProfiles[0];
    const cleanName =
      displayName?.trim() ||
      (email ? email.split('@')[0].replace(/[^a-zA-Z0-9 _-]/g, '') : 'Franchise Owner') ||
      'Franchise Owner';

    const uniquePlayerId = await ensureSequentialPlayerId(profile?.uniquePlayerId ?? null);

    if (!profile) {
      const [createdProfile] = await db
        .insert(userProfiles)
        .values({
          userId: upsertedUser.id,
          uniquePlayerId,
          displayName: cleanName,
          avatarUrl: avatarUrl || null,
          onlineStatus: 'ONLINE',
          lastSeenAt: new Date(),
        })
        .onConflictDoNothing({ target: userProfiles.userId })
        .returning();

      if (createdProfile) {
        profile = createdProfile;
      } else {
        const [refetched] = await db
          .select()
          .from(userProfiles)
          .where(eq(userProfiles.userId, upsertedUser.id))
          .limit(1);
        profile = refetched;
      }
    } else {
      const updates: Partial<typeof userProfiles.$inferInsert> = {
        onlineStatus: 'ONLINE',
        lastSeenAt: new Date(),
      };
      if (profile.uniquePlayerId !== uniquePlayerId) {
        updates.uniquePlayerId = uniquePlayerId;
      }
      const [updated] = await db
        .update(userProfiles)
        .set(updates)
        .where(eq(userProfiles.id, profile.id))
        .returning();
      if (updated) profile = updated;
    }

    return {
      id: upsertedUser.id,
      uid: upsertedUser.uid,
      email: upsertedUser.email,
      role: upsertedUser.role,
      createdAt: upsertedUser.createdAt.toISOString(),
      profile: profile
        ? {
            id: profile.id,
            uniquePlayerId: profile.uniquePlayerId,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            country: profile.country,
            bio: profile.bio,
            preferredRole: profile.preferredRole,
            onlineStatus: 'ONLINE',
          }
        : null,
    };
  } catch (error) {
    logEvent('ERROR', 'Auth', 'Failed to upsert authenticated user', { uid, error: String(error) });
    throw new Error('Failed to synchronize user account.', { cause: error });
  }
}

export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing Bearer token' });
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Empty token' });
  }

  let decodedToken: DecodedIdToken;
  try {
    decodedToken = await adminAuth.verifyIdToken(token);
  } catch (error) {
    logEvent('WARN', 'Auth', 'Invalid Firebase ID token', { error: String(error) });
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired session token' });
  }

  try {
    req.firebaseUser = decodedToken;
    req.dbUser = await getOrCreateDbUser(
      decodedToken.uid,
      decodedToken.email || '',
      decodedToken.name,
      decodedToken.picture || null
    );
    return next();
  } catch (error) {
    logEvent('ERROR', 'Auth', 'Authenticated user DB sync failed', {
      uid: decodedToken.uid,
      error: String(error),
    });
    return res.status(500).json({ error: 'Failed to synchronize franchise account with server.' });
  }
};

export const requireAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.dbUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.dbUser.role !== 'ADMIN' && req.dbUser.role !== 'OWNER') {
    return res.status(403).json({ error: 'Forbidden: Administrator access required' });
  }
  return next();
};
