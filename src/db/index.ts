import net from 'node:net';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';
import { createMemoryDb } from './memoryDb.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

function probePostgres(host?: string, port = 5432, timeoutMs = 350): Promise<boolean> {
  if (!host) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export type DatabaseClient = NodePgDatabase<typeof schema>;

const pgAvailable = await probePostgres(process.env.SQL_HOST, Number(process.env.SQL_PORT || 5432));

export const createPool = () => {
  if (!pgAvailable) {
    return {
      query: async () => ({ rows: [] }),
      end: async () => {},
      on: () => {},
    } as unknown as Pool;
  }
  if (!global._postgresPool) {
    global._postgresPool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      max: 10,
      connectionTimeoutMillis: 15000,
    });

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

export const pool = createPool();
export const db: DatabaseClient = pgAvailable
  ? drizzle(pool, { schema })
  : (createMemoryDb() as unknown as DatabaseClient);

if (!pgAvailable) {
  console.warn('[AI Studio] PostgreSQL not reachable — using in-memory relational store');
}

