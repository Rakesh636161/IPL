import assert from 'node:assert/strict';
import test from 'node:test';
import dotenv from 'dotenv';
import { eq, inArray } from 'drizzle-orm';

dotenv.config();

import { db, pool } from '../src/db/index.ts';
import { ensurePlayersSeeded, generateFictionalPlayers } from '../src/db/seedPlayers.ts';
import {
  auditLogs,
  leagues,
  players,
  teamPlayers,
  teams,
  userProfiles,
  users,
} from '../src/db/schema.ts';
import { DbUserRecord, getOrCreateDbUser } from '../server/middleware/auth.ts';
import { createLeague, joinLeagueByCode } from '../server/services/leagueService.ts';
import {
  listFriendsAndRequests,
  removeFriend,
  respondToFriendRequest,
  searchUsersByPlayerId,
  sendFriendRequest,
} from '../server/services/friendService.ts';
import { getUserStatistics } from '../server/services/userStatsService.ts';
import {
  clearAuctionTimers,
  finalizeCurrentLot,
  getAuctionSnapshot,
  pauseAuction,
  placeBid,
  resumeAuction,
  startAuction,
  stopAuctionTicker,
} from '../server/services/auctionEngine.ts';
import { updateTeamLineup } from '../server/services/teamService.ts';
import { coordinator } from '../server/lib/realtimeCoordinator.ts';

const createdUserIds: string[] = [];
const createdLeagueIds: string[] = [];

test.after(async () => {
  stopAuctionTicker();
  if (createdLeagueIds.length > 0) {
    for (const lid of createdLeagueIds) clearAuctionTimers(lid);
    await db.delete(leagues).where(inArray(leagues.id, createdLeagueIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(auditLogs).where(inArray(auditLogs.actorUserId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await pool.end();
});

test('1. Fictional player generator produces 120 balanced players across all 6 roles', () => {
  const sample = generateFictionalPlayers(120);
  assert.equal(sample.length, 120);
  const roles = new Set(sample.map((p) => p.role));
  assert.ok(roles.has('BATSMAN'));
  assert.ok(roles.has('BOWLER'));
  assert.ok(roles.has('ALL_ROUNDER'));
  assert.ok(roles.has('WICKETKEEPER'));
  assert.ok(roles.has('FAST_BOWLER'));
  assert.ok(roles.has('SPIN_BOWLER'));
});

test('2. End-to-End 12-Team Multiplayer Auction Concurrency, Purse, Idempotency & Squad Rules', async () => {
  await ensurePlayersSeeded();
  const dbPlayerCount = await db.select({ id: players.id }).from(players);
  assert.ok(dbPlayerCount.length >= 100, 'Expected at least 100 seeded players in PostgreSQL');

  // Create 13 test users (12 league participants + 1 overflow user to test capacity cap)
  const suffix = Date.now().toString(36);
  const participants: DbUserRecord[] = [];
  for (let i = 0; i < 13; i++) {
    const u = await getOrCreateDbUser(
      `test-uid-${suffix}-${i}`,
      `owner${i}-${suffix}@cricketverse.test`,
      `Owner ${i}`
    );
    createdUserIds.push(u.id);
    assert.match(u.profile?.uniquePlayerId || '', /^CV\d{6,}$/, 'Sequential Unique Player ID generated');
    participants.push(u);
  }

  // Friend system verification
  const req = await sendFriendRequest(participants[0].id, participants[1].profile!.uniquePlayerId);
  const accepted = await respondToFriendRequest(participants[1].id, req.id, 'ACCEPT');
  assert.equal(accepted.status, 'ACCEPTED');

  // Create 12-team league with purse 1000L, maxSquadSize 11, bidIncrement 25L
  const { league, team: hostTeam } = await createLeague(participants[0].id, {
    name: `Concurrency Cup ${suffix}`,
    visibility: 'PRIVATE',
    maxTeams: 12,
    purseAmount: 1000,
    minSquadSize: 11,
    maxSquadSize: 11,
    bidIncrement: 25,
    timerSeconds: 15,
    auctionMode: 'FAST_TRACK',
    teamName: 'Franchise 0',
    teamShortName: 'FR0',
  });
  createdLeagueIds.push(league.id);

  const allTeams = [hostTeam];
  for (let i = 1; i < 12; i++) {
    const joined = await joinLeagueByCode(
      participants[i].id,
      league.inviteCode,
      `Franchise ${i}`,
      `F${String(i).padStart(2, '0')}`
    );
    allTeams.push(joined.team!);
  }
  assert.equal(allTeams.length, 12);

  // 13th participant must be rejected with LEAGUE_FULL
  await assert.rejects(
    () => joinLeagueByCode(participants[12].id, league.inviteCode, 'Overflow XI', 'OVF'),
    /LEAGUE_FULL/
  );

  // Start Auction
  const startSnap = await startAuction(league.id, participants[0].id);
  assert.ok(startSnap);
  assert.equal(startSnap.auction.state, 'LIVE');
  assert.ok(startSnap.currentPlayer);
  const lot1BasePrice = startSnap.currentLot!.basePrice;
  const lot1PlayerId = startSnap.currentPlayer!.id;

  // Test invalid low bid
  await assert.rejects(
    () =>
      placeBid({
        leagueId: league.id,
        userId: participants[1].id,
        amount: Math.max(1, lot1BasePrice - 10),
      }),
    /MIN_BID_REQUIRED/
  );

  // Test insufficient purse bid (> 1000)
  await assert.rejects(
    () =>
      placeBid({
        leagueId: league.id,
        userId: participants[1].id,
        amount: 1500,
      }),
    /INSUFFICIENT_PURSE/
  );

  // Test 12 simultaneous bids at the exact same opening amount: ONLY ONE must succeed
  const raceResults = await Promise.allSettled(
    participants.slice(0, 12).map((p, idx) =>
      placeBid({
        leagueId: league.id,
        userId: p.id,
        amount: lot1BasePrice,
        idempotencyKey: `race-open-${idx}`,
      })
    )
  );
  const winners = raceResults.filter((r) => r.status === 'fulfilled');
  assert.equal(winners.length, 1, 'Exactly one franchise must win the simultaneous opening bid race');

  const firstWinnerUserId = (await getAuctionSnapshot(league.id))!.auction.highestBidderUserId!;
  const challenger = participants.find((p) => p.id !== firstWinnerUserId && participants.indexOf(p) < 12)!;

  // Self-outbid rejection
  await assert.rejects(
    () =>
      placeBid({
        leagueId: league.id,
        userId: firstWinnerUserId,
        amount: lot1BasePrice + 25,
      }),
    /ALREADY_HIGHEST_BIDDER/
  );

  // Idempotent duplicate bid check
  const idemKey = `idem-bid-${suffix}`;
  const bidPrice = lot1BasePrice + 25;
  const firstCall = await placeBid({
    leagueId: league.id,
    userId: challenger.id,
    amount: bidPrice,
    idempotencyKey: idemKey,
  });
  assert.equal(firstCall.deduplicated, false);

  const duplicateCall = await placeBid({
    leagueId: league.id,
    userId: challenger.id,
    amount: bidPrice,
    idempotencyKey: idemKey,
  });
  assert.equal(duplicateCall.deduplicated, true);

  // Pause & Resume + State Sync recovery
  const pausedSnap = await pauseAuction(league.id, participants[0].id);
  assert.equal(pausedSnap?.auction.state, 'PAUSED');
  await assert.rejects(
    () => placeBid({ leagueId: league.id, userId: firstWinnerUserId, amount: bidPrice + 25 }),
    /AUCTION_NOT_ACCEPTING_BIDS/
  );
  const resumedSnap = await resumeAuction(league.id, participants[0].id);
  assert.equal(resumedSnap?.auction.state, 'BIDDING');

  // Finalize Lot 1 & verify single ownership + exact purse deduction
  const finalizedSnap = await finalizeCurrentLot(league.id, true);
  assert.ok(finalizedSnap);
  const ownershipRows = await db
    .select()
    .from(teamPlayers)
    .where(eq(teamPlayers.leagueId, league.id));
  assert.equal(ownershipRows.length, 1, 'Exactly 1 ownership record created for Lot 1');
  assert.equal(ownershipRows[0].playerId, lot1PlayerId);
  assert.equal(ownershipRows[0].purchasePrice, bidPrice);

  const winningTeamRow = await db
    .select()
    .from(teams)
    .where(eq(teams.id, ownershipRows[0].teamId))
    .limit(1);
  assert.equal(winningTeamRow[0].remainingPurse, 1000 - bidPrice);
  assert.equal(winningTeamRow[0].squadCount, 1);

  // Team management: assign Playing XI & Captain
  const updatedRoster = await updateTeamLineup(challenger.id, winningTeamRow[0].id, {
    teamName: 'Challenger Monarchs',
    captainPlayerId: lot1PlayerId,
    playingXiIds: [lot1PlayerId],
    bowlingOrderIds: [],
  });
  assert.equal(updatedRoster?.team.name, 'Challenger Monarchs');
  assert.equal(updatedRoster?.team.captainPlayerId, lot1PlayerId);

  // Reconnection state recovery snapshot check
  const reconnectSnap = await getAuctionSnapshot(league.id);
  assert.ok(reconnectSnap);
  assert.equal(reconnectSnap.auction.state, 'LIVE');
  assert.equal(reconnectSnap.history.length, 1);
  assert.equal(reconnectSnap.history[0].status, 'SOLD');

  clearAuctionTimers(league.id);
});

test('3. PostgreSQL coordinator enforces distributed lock exclusivity and TTL cache', async () => {
  assert.equal(coordinator.mode, 'postgresql');
  const lockKey = `test-lock-${Date.now()}`;
  const holderA = await coordinator.acquireLock(lockKey, 10000, 'node-A');
  assert.equal(holderA, 'node-A');

  // Second node must be denied while lock is active
  const holderB = await coordinator.acquireLock(lockKey, 10000, 'node-B');
  assert.equal(holderB, null);

  await coordinator.releaseLock(lockKey, 'node-A');
  const holderBAfterRelease = await coordinator.acquireLock(lockKey, 10000, 'node-B');
  assert.equal(holderBAfterRelease, 'node-B');
  await coordinator.releaseLock(lockKey, 'node-B');

  const cacheKey = `test-cache-${Date.now()}`;
  await coordinator.setCache(cacheKey, { lot: 5, bid: 250 }, 10000);
  const cached = await coordinator.getCache<{ lot: number; bid: number }>(cacheKey);
  assert.deepEqual(cached, { lot: 5, bid: 250 });
  await coordinator.deleteCache(cacheKey);
  const afterDelete = await coordinator.getCache(cacheKey);
  assert.equal(afterDelete, null);
});

test('4. Sequential CV100001+ IDs, Profile Persistence, Statistics, and Friend System Guards', async () => {
  const suffix = Date.now().toString(36);

  // Concurrent user registration must produce distinct sequential CV100001+ IDs
  const created = await Promise.all([
    getOrCreateDbUser(`test-uid-seq-a-${suffix}`, `alpha-${suffix}@cv.test`, 'Alpha Owner'),
    getOrCreateDbUser(`test-uid-seq-b-${suffix}`, `beta-${suffix}@cv.test`, 'Beta Owner'),
    getOrCreateDbUser(`test-uid-seq-c-${suffix}`, `gamma-${suffix}@cv.test`, 'Gamma Owner'),
  ]);
  for (const u of created) createdUserIds.push(u.id);

  const ids = created.map((u) => u.profile!.uniquePlayerId);
  for (const id of ids) {
    assert.match(id, /^CV\d{6,}$/);
  }
  assert.equal(new Set(ids).size, 3, 'All concurrent users must receive unique Player IDs');

  // Calling getOrCreateDbUser again (reload/re-login) preserves the exact permanent Player ID
  const reloaded = await getOrCreateDbUser(
    `test-uid-seq-a-${suffix}`,
    `alpha-${suffix}@cv.test`,
    'Alpha Owner'
  );
  assert.equal(reloaded.profile?.uniquePlayerId, ids[0]);

  // Update username & profile picture, verify persistence without altering uniquePlayerId
  const newAvatar = '/src/assets/images/player_batsman_portrait_1794578454251.jpg';
  await db
    .update(userProfiles)
    .set({ displayName: 'Alpha Striker', avatarUrl: newAvatar, country: 'India' })
    .where(eq(userProfiles.userId, created[0].id));

  const afterEdit = await getOrCreateDbUser(
    `test-uid-seq-a-${suffix}`,
    `alpha-${suffix}@cv.test`,
    'Alpha Striker'
  );
  assert.equal(afterEdit.profile?.displayName, 'Alpha Striker');
  assert.equal(afterEdit.profile?.avatarUrl, newAvatar);
  assert.equal(afterEdit.profile?.uniquePlayerId, ids[0]);

  // Statistics retrieval
  const stats = await getUserStatistics(created[0].id, created[0].uid);
  assert.equal(stats.uid, created[0].uid);
  assert.ok(Date.parse(stats.registrationDate) > 0);
  assert.equal(typeof stats.totalMatches, 'number');
  assert.equal(typeof stats.totalWins, 'number');
  assert.equal(typeof stats.totalTournaments, 'number');
  assert.ok(Array.isArray(stats.auctionHistory));

  // Search by unique Player ID (should not include self)
  const searchSelf = await searchUsersByPlayerId(created[0].id, ids[0]);
  assert.equal(searchSelf.length, 0);

  const searchBeta = await searchUsersByPlayerId(created[0].id, ids[1]);
  assert.equal(searchBeta.length, 1);
  assert.equal(searchBeta[0].uniquePlayerId, ids[1]);

  // Prevent adding self as friend
  await assert.rejects(() => sendFriendRequest(created[0].id, ids[0]), /CANNOT_ADD_SELF/);

  // Send request and prevent duplicate pending request
  const freq = await sendFriendRequest(created[0].id, ids[1]);
  await assert.rejects(() => sendFriendRequest(created[0].id, ids[1]), /REQUEST_PENDING/);
  await assert.rejects(() => sendFriendRequest(created[1].id, ids[0]), /REQUEST_PENDING/);

  // Accept request, prevent duplicate accepted request, list & remove friend
  const accepted = await respondToFriendRequest(created[1].id, freq.id, 'ACCEPT');
  assert.equal(accepted.status, 'ACCEPTED');
  await assert.rejects(() => sendFriendRequest(created[0].id, ids[1]), /ALREADY_FRIENDS/);

  const friendList = await listFriendsAndRequests(created[0].id);
  assert.equal(friendList.accepted.length, 1);
  assert.equal(friendList.accepted[0].uniquePlayerId, ids[1]);

  await removeFriend(created[0].id, freq.id);
  const afterRemove = await listFriendsAndRequests(created[0].id);
  assert.equal(afterRemove.accepted.length, 0);
});


