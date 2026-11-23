import crypto from 'node:crypto';
import { and, eq, gt, lt, or } from 'drizzle-orm';
import { db, pool } from '../../src/db/index.ts';
import { distributedLocks, realtimeCache } from '../../src/db/schema.ts';
import { logEvent } from './logger.ts';

/**
 * PostgreSQL-backed Distributed Real-Time Coordinator.
 * Replaces Redis with PostgreSQL row-level lease locks, TTL state cache,
 * and pg_notify event publishing.
 */
export interface RealtimeCoordinator {
  mode: 'postgresql';
  acquireLock(key: string, ttlMs: number, holderId?: string): Promise<string | null>;
  releaseLock(key: string, holderId: string): Promise<void>;
  setCache(key: string, value: unknown, ttlMs: number): Promise<void>;
  getCache<T = unknown>(key: string): Promise<T | null>;
  deleteCache(key: string): Promise<void>;
  publish(channel: string, payload: unknown): Promise<void>;
}

class PostgresRealtimeCoordinator implements RealtimeCoordinator {
  public readonly mode = 'postgresql' as const;

  async acquireLock(key: string, ttlMs: number, holderId?: string): Promise<string | null> {
    const owner = holderId || crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    try {
      const rows = await db
        .insert(distributedLocks)
        .values({
          lockKey: key,
          holderId: owner,
          expiresAt,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: distributedLocks.lockKey,
          set: {
            holderId: owner,
            expiresAt,
            createdAt: now,
          },
          setWhere: or(
            lt(distributedLocks.expiresAt, now),
            eq(distributedLocks.holderId, owner)
          ),
        })
        .returning({ holderId: distributedLocks.holderId });

      return rows.length > 0 && rows[0].holderId === owner ? owner : null;
    } catch (error) {
      logEvent('ERROR', 'Coordinator', 'PostgreSQL acquireLock failed', { key, error: String(error) });
      return null;
    }
  }

  async releaseLock(key: string, holderId: string): Promise<void> {
    try {
      await db
        .delete(distributedLocks)
        .where(and(eq(distributedLocks.lockKey, key), eq(distributedLocks.holderId, holderId)));
    } catch (error) {
      logEvent('WARN', 'Coordinator', 'PostgreSQL releaseLock failed', { key, error: String(error) });
    }
  }

  async setCache(key: string, value: unknown, ttlMs: number): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    await db
      .insert(realtimeCache)
      .values({
        cacheKey: key,
        value,
        expiresAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: realtimeCache.cacheKey,
        set: {
          value,
          expiresAt,
          updatedAt: now,
        },
      });
  }

  async getCache<T = unknown>(key: string): Promise<T | null> {
    const now = new Date();
    const rows = await db
      .select({ value: realtimeCache.value })
      .from(realtimeCache)
      .where(and(eq(realtimeCache.cacheKey, key), gt(realtimeCache.expiresAt, now)))
      .limit(1);

    return rows[0] ? (rows[0].value as T) : null;
  }

  async deleteCache(key: string): Promise<void> {
    await db.delete(realtimeCache).where(eq(realtimeCache.cacheKey, key));
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    try {
      const safeChannel = channel.replace(/[^a-zA-Z0-9_]/g, '_');
      await pool.query('SELECT pg_notify($1, $2)', [safeChannel, JSON.stringify(payload)]);
    } catch (error) {
      logEvent('WARN', 'Coordinator', 'PostgreSQL pg_notify publish failed', {
        channel,
        error: String(error),
      });
    }
  }
}

export function createRealtimeCoordinator(): RealtimeCoordinator {
  return new PostgresRealtimeCoordinator();
}

export const coordinator = createRealtimeCoordinator();
