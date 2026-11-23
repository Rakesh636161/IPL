import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import dotenv from 'dotenv';
import { and, eq, inArray } from 'drizzle-orm';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

dotenv.config();

import { db, pool } from '../src/db/index.ts';
import { ensurePlayersSeeded } from '../src/db/seedPlayers.ts';
import {
  auctionBids,
  auctionLots,
  auctions,
  auditLogs,
  leagues,
  players,
  teamPlayers,
  teams,
  users,
} from '../src/db/schema.ts';
import { DbUserRecord, getOrCreateDbUser } from '../server/middleware/auth.ts';
import { createLeague, joinLeagueByCode } from '../server/services/leagueService.ts';
import {
  cancelAuction,
  clearAuctionTimers,
  computeMinimumBidIncrement,
  configureAuction,
  endAuction,
  finalizeCurrentLot,
  getAuctionSnapshot,
  listAuctionDashboard,
  pauseAuction,
  placeBid,
  recoverActiveAuctions,
  resumeAuction,
  skipCurrentLot,
  startAuction,
  startUnsoldRound,
  stopAuctionTicker,
} from '../server/services/auctionEngine.ts';
import { initializeAuctionSocket, SocketTokenVerifier } from '../server/socket/auctionSocket.ts';

const createdUserIds: string[] = [];
const createdLeagueIds: string[] = [];
const activeClients: ClientSocket[] = [];

let testHttpServer: http.Server | null = null;
let serverUrl = '';

const tokenDirectory = new Map<string, { uid: string; email: string; name: string }>();

const testTokenVerifier: SocketTokenVerifier = {
  async verifyIdToken(token: string) {
    const entry = tokenDirectory.get(token);
    if (!entry) {
      throw new Error('INVALID_TEST_TOKEN');
    }
    return entry;
  },
};

function connectClient(token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(serverUrl, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    activeClients.push(socket);
    const timer = setTimeout(() => reject(new Error('Socket connect timeout')), 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function emitAck<T = Record<string, unknown>>(
  socket: ClientSocket,
  event: string,
  payload: unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Ack timeout for ${event}`)), 5000);
    socket.emit(event, payload, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function waitForSocketEvent<T = unknown>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timeout waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (data: T) => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(data);
    };
    socket.on(event, onEvent);
  });
}

test.before(async () => {
  await ensurePlayersSeeded();
  testHttpServer = http.createServer();
  initializeAuctionSocket(testHttpServer, testTokenVerifier);
  await new Promise<void>((resolve) => {
    testHttpServer!.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = testHttpServer.address();
  assert.ok(addr && typeof addr === 'object');
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

test.after(async () => {
  for (const s of activeClients) {
    if (s.connected) s.disconnect();
  }
  stopAuctionTicker();
  if (createdLeagueIds.length > 0) {
    for (const lid of createdLeagueIds) clearAuctionTimers(lid);
    await db.delete(leagues).where(inArray(leagues.id, createdLeagueIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(auditLogs).where(inArray(auditLogs.actorUserId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  if (testHttpServer) {
    await new Promise<void>((resolve) => testHttpServer!.close(() => resolve()));
  }
  await pool.end();
});

test('Prompt 5.1: Tiered bid increment unit verification (5L / 10L / 25L & custom flat)', () => {
  assert.equal(computeMinimumBidIncrement(20, { useTieredIncrements: true }), 5);
  assert.equal(computeMinimumBidIncrement(95, { useTieredIncrements: true }), 5);
  assert.equal(computeMinimumBidIncrement(100, { useTieredIncrements: true }), 10);
  assert.equal(computeMinimumBidIncrement(500, { useTieredIncrements: true }), 10);
  assert.equal(computeMinimumBidIncrement(501, { useTieredIncrements: true }), 25);
  assert.equal(
    computeMinimumBidIncrement(40, { useTieredIncrements: false, bidIncrement: 20 }),
    20
  );
});

test('Prompt 5.2: 12-Participant Real-Time Socket.IO Multiplayer Auction, Lock, Overseas Cap, Extensions, Skip, Round 2 & Reconnect', async () => {
  const suffix = `p5_${Date.now().toString(36)}`;
  const participants: DbUserRecord[] = [];
  const tokens: string[] = [];

  for (let i = 0; i < 12; i++) {
    const uid = `uid-p5-${suffix}-${i}`;
    const email = `p5_${i}_${suffix}@cricketverse.test`;
    const name = `Franchise Owner ${i}`;
    const user = await getOrCreateDbUser(uid, email, name);
    createdUserIds.push(user.id);
    participants.push(user);

    const token = `tok-${suffix}-${i}`;
    tokenDirectory.set(token, { uid, email, name });
    tokens.push(token);
  }

  // Pick 3 Overseas + 3 Domestic active players from seeded DB
  const allDbPlayers = await db.select().from(players);
  const overseasPool = allDbPlayers.filter((p) => p.isOverseas && p.isActive).slice(0, 3);
  const domesticPool = allDbPlayers.filter((p) => !p.isOverseas && p.isActive).slice(0, 3);
  assert.equal(overseasPool.length, 3);
  assert.equal(domesticPool.length, 3);

  // Order: [OS0, OS1, OS2, DOM0, DOM1, DOM2]
  const orderedIds = [
    overseasPool[0].id,
    overseasPool[1].id,
    overseasPool[2].id,
    domesticPool[0].id,
    domesticPool[1].id,
    domesticPool[2].id,
  ];
  const baseOverrides: Record<string, number> = {};
  for (const pid of orderedIds) {
    baseOverrides[pid] = 20;
  }

  // Host creates league with 12 max teams
  const { league } = await createLeague(participants[0].id, {
    name: `Mega Arena ${suffix}`,
    visibility: 'PRIVATE',
    maxTeams: 12,
    purseAmount: 1000,
    minSquadSize: 2,
    maxSquadSize: 10,
    bidIncrement: 10,
    timerSeconds: 10,
    auctionMode: 'MEGA',
    teamName: 'Titan Franchise 0',
    teamShortName: 'TF0',
  });
  createdLeagueIds.push(league.id);

  for (let i = 1; i < 12; i++) {
    await joinLeagueByCode(
      participants[i].id,
      league.inviteCode,
      `Titan Franchise ${i}`,
      `T${String(i).padStart(2, '0')}`
    );
  }

  // Pre-start configuration by host
  const configured = await configureAuction(league.id, participants[0].id, {
    name: `Grand Slam Auction ${suffix}`,
    purseAmount: 1000,
    minSquadSize: 2,
    maxSquadSize: 10,
    maxOverseas: 2,
    timerSeconds: 10,
    maxTimerExtensions: 4,
    useTieredIncrements: true,
    tier1Increment: 5,
    tier2Increment: 10,
    tier3Increment: 25,
    playerOrderMode: 'MANUAL',
    manualPlayerIds: orderedIds,
    basePriceOverrides: baseOverrides,
    playerPoolLimit: 6,
    enableSecondRound: true,
    allowSkipPlayer: true,
  });
  assert.ok(configured);
  assert.equal(configured.auction.settingsLocked, false);
  assert.equal(configured.settings?.maxOverseas, 2);

  // Dashboard API verification
  const dash = await listAuctionDashboard(participants[0].id);
  const myDashItem = dash.auctions.find((a) => a.leagueId === league.id);
  assert.ok(myDashItem);
  assert.equal(myDashItem.participatingTeamsCount, 12);
  assert.equal(myDashItem.participatingOwners.length, 12);

  // Connect all 12 Socket.IO clients simultaneously and join room
  const sockets = await Promise.all(tokens.map((t) => connectClient(t)));
  const joinAcks = await Promise.all(
    sockets.map((s) => emitAck<{ ok: boolean; snapshot?: unknown }>(s, 'auction:join', { leagueId: league.id }))
  );
  assert.ok(joinAcks.every((a) => a.ok));

  // Host starts auction over Socket.IO
  const startedPromises = sockets.map((s) => waitForSocketEvent(s, 'auction:started'));
  const startAck = await emitAck<{ ok: boolean }>(sockets[0], 'auction:start', { leagueId: league.id });
  assert.equal(startAck.ok, true);
  await Promise.all(startedPromises);

  // Settings MUST now be locked
  await assert.rejects(
    () => configureAuction(league.id, participants[0].id, { timerSeconds: 25 }),
    /AUCTION_SETTINGS_LOCKED/
  );

  // LOT 1 (OS0 @ base 20L): 12 simultaneous Socket.IO bids -> strictly ONE succeeds!
  const bidAckPromises = sockets.map((s, idx) =>
    emitAck<{ ok: boolean; error?: string }>(s, 'auction:bid', {
      leagueId: league.id,
      amount: 20,
      idempotencyKey: `sim12-${suffix}-${idx}`,
    })
  );
  const bidAcks = await Promise.all(bidAckPromises);
  const acceptedAcks = bidAcks.filter((a) => a.ok);
  const rejectedAcks = bidAcks.filter((a) => !a.ok);
  assert.equal(acceptedAcks.length, 1, 'Strictly 1 concurrent Socket.IO bid must win');
  assert.equal(rejectedAcks.length, 11);

  // Force Lot 1 win for participants[1] (Team 1) so Team 1 has 1 overseas player
  let snap1 = await getAuctionSnapshot(league.id);
  assert.ok(snap1);
  if (snap1.auction.highestBidderUserId !== participants[1].id) {
    // Below 100L, tiered increment is +5L => 25L
    const res = await emitAck<{ ok: boolean; error?: string }>(sockets[1], 'auction:bid', {
      leagueId: league.id,
      amount: 25,
    });
    assert.equal(res.ok, true);
  }

  // Test invalid below-minimum bid (< +5L) & negative/zero & insufficient purse (> 1000L)
  const lowBidAck = await emitAck<{ ok: boolean; error?: string }>(sockets[2], 'auction:bid', {
    leagueId: league.id,
    amount: 26,
  });
  assert.equal(lowBidAck.ok, false);
  assert.match(lowBidAck.error || '', /MIN_BID_REQUIRED/);

  const zeroBidAck = await emitAck<{ ok: boolean; error?: string }>(sockets[2], 'auction:bid', {
    leagueId: league.id,
    amount: 0,
  });
  assert.equal(zeroBidAck.ok, false);

  const richBidAck = await emitAck<{ ok: boolean; error?: string }>(sockets[2], 'auction:bid', {
    leagueId: league.id,
    amount: 1500,
  });
  assert.equal(richBidAck.ok, false);
  assert.match(richBidAck.error || '', /INSUFFICIENT_PURSE/);

  // Test tiered jump from 25 -> 100L (next increment becomes +10L)
  const jumpAck = await emitAck<{ ok: boolean; error?: string }>(sockets[3], 'auction:bid', {
    leagueId: league.id,
    amount: 100,
  });
  assert.equal(jumpAck.ok, true);
  // At 100L, 105L must reject because tier 100..500L requires +10L (110L)
  const badTierAck = await emitAck<{ ok: boolean; error?: string }>(sockets[1], 'auction:bid', {
    leagueId: league.id,
    amount: 105,
  });
  assert.equal(badTierAck.ok, false);
  assert.match(badTierAck.error || '', /MIN_BID_REQUIRED:110/);

  // Team 1 wins OS0 at 110L
  const team1Win1 = await emitAck<{ ok: boolean; error?: string }>(sockets[1], 'auction:bid', {
    leagueId: league.id,
    amount: 110,
  });
  assert.equal(team1Win1.ok, true);

  // Max timer extensions (maxTimerExtensions = 4): push to cap and verify timer stops extending
  const snapBeforeExt = await getAuctionSnapshot(league.id);
  let extUsed = snapBeforeExt!.auction.timerExtensionsUsed ?? 0;
  let curBid = snapBeforeExt!.auction.currentBid!;
  let altIdx = 2;
  while (extUsed < 4) {
    const inc = computeMinimumBidIncrement(curBid, { useTieredIncrements: true });
    curBid += inc;
    const extAck = await emitAck<{ ok: boolean }>(sockets[altIdx], 'auction:bid', {
      leagueId: league.id,
      amount: curBid,
    });
    assert.equal(extAck.ok, true);
    extUsed += 1;
    altIdx = altIdx === 2 ? 1 : 2;
  }

  // At extension cap, a bid is accepted WITHOUT resetting/extending lotDeadlineAt
  const snapAtCap = await getAuctionSnapshot(league.id);
  const frozenDeadline = snapAtCap!.auction.lotDeadlineAt;
  const cappedBidAmount = (snapAtCap!.auction.currentBid ?? 0) + 10;
  const bidderForWin1 = snapAtCap!.auction.highestBidderUserId === participants[1].id ? 4 : 1;
  const cappedAck = await emitAck<{ ok: boolean; error?: string }>(sockets[bidderForWin1], 'auction:bid', {
    leagueId: league.id,
    amount: cappedBidAmount,
  });
  assert.equal(cappedAck.ok, true);
  let snapAfterCap = await getAuctionSnapshot(league.id);
  assert.equal(snapAfterCap!.auction.timerExtensionsUsed, 4);
  assert.equal(
    new Date(snapAfterCap!.auction.lotDeadlineAt!).getTime(),
    new Date(frozenDeadline!).getTime(),
    'Deadline must not extend past maxTimerExtensions'
  );

  // Ensure Team 1 holds winning bid on OS0 so Team 1 reaches 1 overseas player
  if (snapAfterCap!.auction.highestBidderUserId !== participants[1].id) {
    const inc = computeMinimumBidIncrement(snapAfterCap!.auction.currentBid!, { useTieredIncrements: true });
    const t1TakeAck = await emitAck<{ ok: boolean }>(sockets[1], 'auction:bid', {
      leagueId: league.id,
      amount: snapAfterCap!.auction.currentBid! + inc,
    });
    assert.equal(t1TakeAck.ok, true);
  }

  // Finalize Lot 1 (OS0) -> confirm single ownership & winning bid marked
  const soldWait = Promise.all(sockets.map((s) => waitForSocketEvent(s, 'auction:sold')));
  await emitAck(sockets[0], 'auction:nextLot', { leagueId: league.id });
  await soldWait;

  // LOT 2 (OS1): Award to Team 1 so Team 1 reaches maxOverseas = 2
  snap1 = await getAuctionSnapshot(league.id);
  assert.equal(snap1!.currentPlayer!.id, overseasPool[1].id);
  const l2Ack = await emitAck<{ ok: boolean }>(sockets[1], 'auction:bid', {
    leagueId: league.id,
    amount: 20,
  });
  assert.equal(l2Ack.ok, true);
  await emitAck(sockets[0], 'auction:nextLot', { leagueId: league.id });

  // LOT 3 (OS2): Team 1 now holds 2 overseas players and MUST be rejected with OVERSEAS_LIMIT_REACHED
  const snapLot3 = await getAuctionSnapshot(league.id);
  const team1Lot3 = snapLot3!.teams.find((t) => t.ownerId === participants[1].id)!;
  assert.equal(team1Lot3.overseasCount, 2);
  const osRejected = await emitAck<{ ok: boolean; error?: string }>(sockets[1], 'auction:bid', {
    leagueId: league.id,
    amount: 20,
  });
  assert.equal(osRejected.ok, false);
  assert.equal(osRejected.error, 'OVERSEAS_LIMIT_REACHED');

  // Ensure we advance/skip until DOM0 is active, testing skipCurrentLot + Round 2 Unsold!
  let currentSnap = await getAuctionSnapshot(league.id);
  if (currentSnap!.currentPlayer!.id === overseasPool[2].id) {
    // Host skips OS2 cleanly with zero bids so OS2 goes to UNSOLD pool for Round 2!
    const skipAck = await emitAck<{ ok: boolean }>(sockets[0], 'auction:skip', { leagueId: league.id });
    assert.equal(skipAck.ok, true);
    currentSnap = await getAuctionSnapshot(league.id);
  }

  // Now DOM0 is active!
  assert.equal(currentSnap!.currentPlayer!.id, domesticPool[0].id);

  // Team 1 (at maxOverseas === 2) CAN bid and win Domestic player DOM0!
  const domBidAck = await emitAck<{ ok: boolean; error?: string }>(sockets[1], 'auction:bid', {
    leagueId: league.id,
    amount: 20,
  });
  assert.equal(domBidAck.ok, true);

  // Cannot skip once a valid bid exists!
  await assert.rejects(() => skipCurrentLot(league.id, participants[0].id), /CANNOT_SKIP_ACTIVE_BIDDING/);

  // Test Disconnect + Reconnect state synchronization on Socket 5
  sockets[5].disconnect();
  const team2Bid = await emitAck<{ ok: boolean }>(sockets[2], 'auction:bid', {
    leagueId: league.id,
    amount: 25,
  });
  assert.equal(team2Bid.ok, true);

  const reconnected5 = await connectClient(tokens[5]);
  const rejoinAck = await emitAck<{ ok: boolean; snapshot: NonNullable<typeof currentSnap> }>(
    reconnected5,
    'auction:join',
    { leagueId: league.id }
  );
  assert.equal(rejoinAck.ok, true);
  assert.equal(rejoinAck.snapshot.auction.currentBid, 25);
  assert.equal(rejoinAck.snapshot.auction.highestBidderUserId, participants[2].id);

  // Test Pause & Resume preserving remaining ms
  const pauseSnap = await pauseAuction(league.id, participants[0].id);
  assert.equal(pauseSnap?.auction.state, 'PAUSED');
  assert.ok((pauseSnap?.auction.pausedRemainingMs ?? 0) >= 250);
  const pausedBid = await emitAck<{ ok: boolean; error?: string }>(sockets[3], 'auction:bid', {
    leagueId: league.id,
    amount: 30,
  });
  assert.equal(pausedBid.ok, false);
  assert.equal(pausedBid.error, 'AUCTION_NOT_ACCEPTING_BIDS');

  const resumedSnap = await resumeAuction(league.id, participants[0].id);
  assert.equal(resumedSnap?.auction.state, 'BIDDING');

  // Finalize DOM0 -> SOLD to Team 2
  await finalizeCurrentLot(league.id, true);

  // DOM1 & DOM2: Skip DOM1 (goes UNSOLD), bid & sell DOM2 -> Round 1 completes!
  await skipCurrentLot(league.id, participants[0].id); // DOM1 UNSOLD
  await emitAck(sockets[4], 'auction:bid', { leagueId: league.id, amount: 20 });
  const endRound1Snap = await finalizeCurrentLot(league.id, true); // DOM2 SOLD -> COMPLETED
  assert.equal(endRound1Snap?.auction.state, 'COMPLETED');
  assert.ok((endRound1Snap?.auction.unsoldCount ?? 0) >= 1);

  // Start Round 2 for UNSOLD players!
  const round2Ack = await emitAck<{ ok: boolean; snapshot?: { auction: { roundNumber?: number; state: string } } }>(
    sockets[0],
    'auction:unsoldRound',
    { leagueId: league.id }
  );
  assert.equal(round2Ack.ok, true);
  assert.equal(round2Ack.snapshot?.auction.roundNumber, 2);
  assert.equal(round2Ack.snapshot?.auction.state, 'LIVE');

  // Verify rejected bid ledger rows persisted in auctionBids without mutating balances
  const allBids = await db
    .select()
    .from(auctionBids)
    .where(eq(auctionBids.leagueId, league.id));
  assert.ok(allBids.some((b) => b.status === 'ACCEPTED' && b.isWinningBid));
  assert.ok(allBids.some((b) => b.status === 'REJECTED'));

  // End Round 2 cleanly
  const finalEndSnap = await endAuction(league.id, participants[0].id, true);
  assert.equal(finalEndSnap?.auction.state, 'COMPLETED');

  // Verify no duplicate ownership and exact integer purse consistency across all 12 teams
  const leagueTeams = await db.select().from(teams).where(eq(teams.leagueId, league.id));
  const leagueOwned = await db.select().from(teamPlayers).where(eq(teamPlayers.leagueId, league.id));
  const playerIdSet = new Set(leagueOwned.map((r) => r.playerId));
  assert.equal(playerIdSet.size, leagueOwned.length, 'No player owned twice in same league');

  for (const t of leagueTeams) {
    const teamOwned = leagueOwned.filter((r) => r.teamId === t.id);
    const spent = teamOwned.reduce((sum, r) => sum + r.purchasePrice, 0);
    assert.equal(t.squadCount, teamOwned.length);
    assert.equal(t.remainingPurse, t.totalPurse - spent);
    assert.ok(t.remainingPurse >= 0, 'Purse must never go negative');
  }

  for (const s of sockets) s.disconnect();
  reconnected5.disconnect();
  clearAuctionTimers(league.id);
});

test('Prompt 5.3: Automatic Timer Expiry Settlement & Backend Restart Failover Recovery', async () => {
  const suffix = `rec_${Date.now().toString(36)}`;
  const u1 = await getOrCreateDbUser(`uid-rec-1-${suffix}`, `r1_${suffix}@cv.test`, 'Rec Host');
  const u2 = await getOrCreateDbUser(`uid-rec-2-${suffix}`, `r2_${suffix}@cv.test`, 'Rec Guest');
  createdUserIds.push(u1.id, u2.id);

  const { league } = await createLeague(u1.id, {
    name: `Recovery Cup ${suffix}`,
    visibility: 'PRIVATE',
    maxTeams: 4,
    purseAmount: 2000,
    minSquadSize: 1,
    maxSquadSize: 10,
    bidIncrement: 10,
    timerSeconds: 20,
    auctionMode: 'FAST_TRACK',
    teamName: 'Recovery One',
    teamShortName: 'RC1',
  });
  createdLeagueIds.push(league.id);

  await joinLeagueByCode(u2.id, league.inviteCode, 'Recovery Two', 'RC2');

  const startSnap = await startAuction(league.id, u1.id);
  const base = startSnap!.currentLot!.basePrice;
  await placeBid({ leagueId: league.id, userId: u2.id, amount: base });

  // Simulate server crash: clear in-memory timers & force deadline into the past
  clearAuctionTimers(league.id);
  const overdueTime = new Date(Date.now() - 2000);
  await db
    .update(auctions)
    .set({ lotDeadlineAt: overdueTime })
    .where(eq(auctions.leagueId, league.id));

  // Verify LOT_TIMER_EXPIRED when bidding after deadline before recovery sweeps
  await assert.rejects(
    () => placeBid({ leagueId: league.id, userId: u1.id, amount: base + 10 }),
    /LOT_TIMER_EXPIRED/
  );

  // Trigger backend restart recovery!
  const recovery = await recoverActiveAuctions();
  assert.ok(recovery.finalizedCount >= 1, 'Overdue lot must auto-finalize during boot recovery');

  const afterRecSnap = await getAuctionSnapshot(league.id);
  assert.equal(afterRecSnap?.history.length, 1);
  assert.equal(afterRecSnap?.history[0].status, 'SOLD');
  assert.equal(afterRecSnap?.history[0].finalPrice, base);
  assert.equal(afterRecSnap?.auction.lotOrder, 2);

  // Also test future deadline restoration on simulated restart
  clearAuctionTimers(league.id);
  const futureRes = await recoverActiveAuctions();
  assert.ok(futureRes.resumedCount >= 1, 'Active lot with future deadline must re-schedule timer');

  // Test cancelAuction cleanly closes lobby/auction
  const cancelledSnap = await cancelAuction(league.id, u1.id);
  assert.equal(cancelledSnap?.auction.state, 'CANCELLED');
  await assert.rejects(
    () => placeBid({ leagueId: league.id, userId: u1.id, amount: 100 }),
    /AUCTION_NOT_ACCEPTING_BIDS/
  );
  clearAuctionTimers(league.id);
});
