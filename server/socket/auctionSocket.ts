import { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { and, eq } from 'drizzle-orm';
import { adminAuth } from '../../src/lib/firebase-admin.ts';
import { getOrCreateDbUser, DbUserRecord } from '../middleware/auth.ts';
import { db } from '../../src/db/index.ts';
import { leagueMembers, leagues, userProfiles } from '../../src/db/schema.ts';
import {
  cancelAuction,
  endAuction,
  finalizeCurrentLot,
  getAuctionSnapshot,
  pauseAuction,
  placeBid,
  registerAuctionEmitter,
  resumeAuction,
  skipCurrentLot,
  startAuction,
  startUnsoldRound,
} from '../services/auctionEngine.ts';
import { registerLeagueEmitter } from '../services/leagueService.ts';
import { logEvent } from '../lib/logger.ts';

interface AuthenticatedSocket extends Socket {
  dbUser?: DbUserRecord;
}

export interface SocketTokenVerifier {
  verifyIdToken(token: string): Promise<{
    uid: string;
    email?: string;
    name?: string;
    picture?: string;
  }>;
}

export function initializeAuctionSocket(
  httpServer: HttpServer,
  tokenVerifier: SocketTokenVerifier = adminAuth
) {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  registerAuctionEmitter({
    emitToLeague(leagueId: string, event: string, payload: unknown) {
      io.to(`auction:${leagueId}`).emit(event, payload);
    },
  });

  registerLeagueEmitter({
    emitToLeagueLobby(leagueId: string, event: string, payload: unknown) {
      io.to(`league:${leagueId}`).emit(event, payload);
    },
  });

  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token || typeof token !== 'string') {
        return next(new Error('UNAUTHORIZED'));
      }
      const decoded = await tokenVerifier.verifyIdToken(token);
      socket.dbUser = await getOrCreateDbUser(
        decoded.uid,
        decoded.email || '',
        decoded.name,
        decoded.picture || null
      );
      return next();
    } catch (error) {
      logEvent('WARN', 'SocketAuth', 'Socket authentication rejected', { error: String(error) });
      return next(new Error('INVALID_TOKEN'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    const user = socket.dbUser;
    if (!user) {
      socket.disconnect(true);
      return;
    }

    socket.on('league:join', async (payload: { leagueId: string }, ack?: (res: unknown) => void) => {
      try {
        const leagueId = payload?.leagueId;
        if (!leagueId) throw new Error('LEAGUE_ID_REQUIRED');
        await socket.join(`league:${leagueId}`);
        if (ack) ack({ ok: true });
      } catch (error) {
        if (ack) ack({ ok: false, error: error instanceof Error ? error.message : 'JOIN_FAILED' });
      }
    });

    socket.on('league:leave', async (payload: { leagueId: string }) => {
      if (payload?.leagueId) {
        await socket.leave(`league:${payload.leagueId}`);
      }
    });

    socket.on('auction:join', async (payload: { leagueId: string }, ack?: (res: unknown) => void) => {
      try {
        const leagueId = payload?.leagueId;
        if (!leagueId) throw new Error('LEAGUE_ID_REQUIRED');

        const [membership] = await db
          .select()
          .from(leagueMembers)
          .where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, user.id)))
          .limit(1);

        if (!membership && user.role !== 'ADMIN') throw new Error('NOT_LEAGUE_MEMBER');

        await socket.join(`auction:${leagueId}`);
        await db
          .update(userProfiles)
          .set({ onlineStatus: 'IN_AUCTION', lastSeenAt: new Date() })
          .where(eq(userProfiles.userId, user.id));

        const snapshot = await getAuctionSnapshot(leagueId);
        socket.emit('auction:stateSync', snapshot);
        if (ack) ack({ ok: true, snapshot });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'JOIN_FAILED';
        if (ack) ack({ ok: false, error: msg });
      }
    });

    socket.on('auction:start', async (payload: { leagueId: string }, ack?: (res: unknown) => void) => {
      try {
        const snapshot = await startAuction(payload.leagueId, user.id);
        if (ack) ack({ ok: true, snapshot });
      } catch (error) {
        if (ack) ack({ ok: false, error: error instanceof Error ? error.message : 'START_FAILED' });
      }
    });

    socket.on(
      'auction:bid',
      async (
        payload: { leagueId: string; amount: number; idempotencyKey?: string },
        ack?: (res: unknown) => void
      ) => {
        try {
          const result = await placeBid({
            leagueId: payload.leagueId,
            userId: user.id,
            amount: Number(payload.amount),
            idempotencyKey: payload.idempotencyKey,
          });
          if (ack) ack({ ok: true, ...result });
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'BID_REJECTED';
          socket.emit('auction:bidRejected', { error: msg });
          if (ack) ack({ ok: false, error: msg });
        }
      }
    );

    socket.on('auction:pause', async (payload: { leagueId: string }, ack?: (res: unknown) => void) => {
      try {
        const snapshot = await pauseAuction(payload.leagueId, user.id);
        if (ack) ack({ ok: true, snapshot });
      } catch (error) {
        if (ack) ack({ ok: false, error: error instanceof Error ? error.message : 'PAUSE_FAILED' });
      }
    });

    socket.on('auction:resume', async (payload: { leagueId: string }, ack?: (res: unknown) => void) => {
      try {
        const snapshot = await resumeAuction(payload.leagueId, user.id);
        if (ack) ack({ ok: true, snapshot });
      } catch (error) {
        if (ack) ack({ ok: false, error: error instanceof Error ? error.message : 'RESUME_FAILED' });
      }
    });

    socket.on('auction:nextLot', async (payload: { leagueId: string }, ack?: (res: unknown) => void) => {
      try {
        const [league] = await db
          .select({ ownerId: leagues.ownerId })
          .from(leagues)
          .where(eq(leagues.id, payload.leagueId))
          .limit(1);
        if (!league || (league.ownerId !== user.id && user.role !== 'ADMIN')) {
          throw new Error('ONLY_OWNER_CAN_CONTROL');
        }
        const snapshot = await finalizeCurrentLot(payload.leagueId, true);
        if (ack) ack({ ok: true, snapshot });
      } catch (error) {
        if (ack) ack({ ok: false, error: error instanceof Error ? error.message : 'FINALIZE_FAILED' });
      }
    });

    socket.on('auction:skip', async (payload: { leagueId: string }, ack?: (res: unknown) => void) => {
      try {
        const snapshot = await skipCurrentLot(payload.leagueId, user.id);
        if (ack) ack({ ok: true, snapshot });
      } catch (error) {
        if (ack) ack({ ok: false, error: error instanceof Error ? error.message : 'SKIP_FAILED' });
      }
    });

    socket.on('auction:unsoldRound', async (payload: { leagueId: string }, ack?: (res: unknown) => void) => {
      try {
        const snapshot = await startUnsoldRound(payload.leagueId, user.id);
        if (ack) ack({ ok: true, snapshot });
      } catch (error) {
        if (ack) ack({ ok: false, error: error instanceof Error ? error.message : 'ROUND_FAILED' });
      }
    });

    socket.on('auction:end', async (payload: { leagueId: string; force?: boolean }, ack?: (res: unknown) => void) => {
      try {
        const snapshot = await endAuction(payload.leagueId, user.id, Boolean(payload.force));
        if (ack) ack({ ok: true, snapshot });
      } catch (error) {
        if (ack) ack({ ok: false, error: error instanceof Error ? error.message : 'END_FAILED' });
      }
    });

    socket.on('auction:cancel', async (payload: { leagueId: string }, ack?: (res: unknown) => void) => {
      try {
        const snapshot = await cancelAuction(payload.leagueId, user.id);
        if (ack) ack({ ok: true, snapshot });
      } catch (error) {
        if (ack) ack({ ok: false, error: error instanceof Error ? error.message : 'CANCEL_FAILED' });
      }
    });

    socket.on('disconnect', async () => {
      try {
        await db
          .update(userProfiles)
          .set({ onlineStatus: 'ONLINE', lastSeenAt: new Date() })
          .where(eq(userProfiles.userId, user.id));
      } catch {
        // Ignore cleanup errors on disconnect
      }
    });
  });

  return io;
}
