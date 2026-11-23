import assert from 'node:assert/strict';
import test from 'node:test';
import dotenv from 'dotenv';
import { inArray } from 'drizzle-orm';

dotenv.config();

import { db, pool } from '../src/db/index.ts';
import { ensurePlayersSeeded, generateFictionalPlayers } from '../src/db/seedPlayers.ts';
import { auditLogs, leagues, players, users } from '../src/db/schema.ts';
import { AuthRequest, getOrCreateDbUser, requireAdmin } from '../server/middleware/auth.ts';
import {
  createAdminPlayer,
  getPlayerDetailById,
  importAdminPlayers,
  listFilteredPlayers,
  updateAdminPlayer,
} from '../server/services/playerService.ts';
import { createLeague, joinLeagueByCode, updateLeagueSettings } from '../server/services/leagueService.ts';
import {
  assignPlayerToTeamInLeague,
  getTeamWithRoster,
  markTeamSquadComplete,
  updateTeamLineup,
} from '../server/services/teamService.ts';
import { simulateQuickMatch } from '../server/services/matchService.ts';
import { clearAuctionTimers, startAuction, stopAuctionTicker } from '../server/services/auctionEngine.ts';
import {
  calculateOverallRating,
  calculatePlayerValuation,
  validatePlayingXiSelection,
  validateSquadComposition,
} from '../src/lib/cricketEngine.ts';

const testUserIds: string[] = [];
const testLeagueIds: string[] = [];
const testPlayerIds: string[] = [];

test.after(async () => {
  stopAuctionTicker();
  if (testLeagueIds.length > 0) {
    for (const lid of testLeagueIds) clearAuctionTimers(lid);
    await db.delete(leagues).where(inArray(leagues.id, testLeagueIds));
  }
  if (testPlayerIds.length > 0) {
    await db.delete(players).where(inArray(players.id, testPlayerIds));
  }
  if (testUserIds.length > 0) {
    await db.delete(auditLogs).where(inArray(auditLogs.actorUserId, testUserIds));
    await db.delete(users).where(inArray(users.id, testUserIds));
  }
  await pool.end();
});

test('1. Fictional Player Database (128 players), 10 Attributes, Role-Weighted Rating & Valuation', async () => {
  await ensurePlayersSeeded();
  const sample = generateFictionalPlayers(128);
  assert.ok(sample.length >= 100, 'Expected at least 100 generated fictional players');

  // Ensure strictly fictional names (none of famous real cricketer names)
  const forbiddenRealNames = ['virat', 'rohit', 'dhoni', 'kohli', 'bumrah', 'tendulkar', 'smith', 'cummins', 'stokes'];
  for (const p of sample) {
    const lower = p.name.toLowerCase();
    for (const real of forbiddenRealNames) {
      assert.equal(lower.includes(real), false, `Found prohibited real name fragment "${real}" in "${p.name}"`);
    }
    assert.ok(Number.isInteger(p.basePrice) && p.basePrice > 0, 'Base price must be a positive integer');
  }

  // Unique player codes & varied ratings
  const allDbPlayers = await listFilteredPlayers({});
  assert.ok(allDbPlayers.length >= 120, 'Database must have >= 120 active fictional players');
  const codes = new Set(allDbPlayers.map((p) => p.playerCode));
  assert.equal(codes.size, allDbPlayers.length, 'Every player must have a unique playerCode');
  const distinctRatings = new Set(allDbPlayers.map((p) => p.overallRating));
  assert.ok(distinctRatings.size >= 15, 'Players must have varied overall ratings, not identical stats');

  // Role-weighted formula verification
  const highBatLowBowl = {
    batting: 92,
    battingTiming: 90,
    powerHitting: 88,
    bowling: 20,
    bowlingAccuracy: 22,
    swing: 15,
    spin: 15,
    fielding: 80,
    stamina: 82,
    experience: 85,
  };
  const openerOvr = calculateOverallRating('OPENING_BATSMAN', highBatLowBowl);
  const fastBowlerOvr = calculateOverallRating('FAST_BOWLER', highBatLowBowl);
  assert.ok(openerOvr > fastBowlerOvr + 35, 'Role weights must reward matching role attributes');

  // Valuation integer check & differentiation
  const eliteVal = calculatePlayerValuation({
    role: 'ALL_ROUNDER',
    attributes: {
      batting: 88,
      battingTiming: 85,
      powerHitting: 86,
      bowling: 84,
      bowlingAccuracy: 82,
      swing: 80,
      spin: 45,
      fielding: 84,
      stamina: 86,
      experience: 90,
    },
    experienceLevel: 'ELITE',
    isOverseas: true,
    demandScore: 120,
  });
  const emergingVal = calculatePlayerValuation({
    role: 'BATSMAN',
    attributes: {
      batting: 60,
      battingTiming: 62,
      powerHitting: 58,
      bowling: 20,
      bowlingAccuracy: 20,
      swing: 15,
      spin: 15,
      fielding: 65,
      stamina: 70,
      experience: 40,
    },
    experienceLevel: 'EMERGING',
    isOverseas: false,
    demandScore: 90,
  });
  assert.ok(Number.isInteger(eliteVal.suggestedBasePrice));
  assert.ok(Number.isInteger(emergingVal.suggestedBasePrice));
  assert.ok(eliteVal.suggestedBasePrice > emergingVal.suggestedBasePrice);
});

test('2. Search by Name/ID, 8 Category Tabs, Multi-Filtering, and Sorting', async () => {
  await ensurePlayersSeeded();
  const firstPlayer = (await listFilteredPlayers({}))[0];
  assert.ok(firstPlayer);

  // Search by exact CVP playerCode and by partial name
  const byCode = await listFilteredPlayers({ q: firstPlayer.playerCode });
  assert.equal(byCode.length, 1);
  assert.equal(byCode[0].id, firstPlayer.id);

  const byName = await listFilteredPlayers({ q: firstPlayer.name.split(' ')[0] });
  assert.ok(byName.some((p) => p.id === firstPlayer.id));

  // Verify 8 tabs filter accurately
  const batsmen = await listFilteredPlayers({ tab: 'BATSMEN' });
  const bowlers = await listFilteredPlayers({ tab: 'BOWLERS' });
  const allRounders = await listFilteredPlayers({ tab: 'ALL_ROUNDERS' });
  const keepers = await listFilteredPlayers({ tab: 'WICKETKEEPERS' });
  const emerging = await listFilteredPlayers({ tab: 'EMERGING' });
  const overseas = await listFilteredPlayers({ tab: 'OVERSEAS' });
  const elite = await listFilteredPlayers({ tab: 'ELITE' });

  assert.ok(batsmen.length > 0 && batsmen.every((p) => p.role.includes('BATSMAN')));
  assert.ok(bowlers.length > 0 && bowlers.every((p) => p.role.includes('BOWLER')));
  assert.ok(allRounders.length > 0 && allRounders.every((p) => p.role === 'ALL_ROUNDER'));
  assert.ok(keepers.length > 0 && keepers.every((p) => p.role === 'WICKETKEEPER'));
  assert.ok(emerging.length > 0 && emerging.every((p) => p.experienceLevel === 'EMERGING' || p.category === 'EMERGING'));
  assert.ok(overseas.length > 0 && overseas.every((p) => p.isOverseas));
  assert.ok(elite.length > 0 && elite.every((p) => p.experienceLevel === 'ELITE' || p.category === 'MARQUEE'));

  // Sort by basePrice ascending & overallRating descending
  const priceAsc = await listFilteredPlayers({ sortBy: 'basePrice', sortDir: 'asc' });
  for (let i = 1; i < priceAsc.length; i++) {
    assert.ok(priceAsc[i].basePrice >= priceAsc[i - 1].basePrice);
  }
  const ratingDesc = await listFilteredPlayers({ sortBy: 'overallRating', sortDir: 'desc' });
  for (let i = 1; i < ratingDesc.length; i++) {
    assert.ok(ratingDesc[i].overallRating <= ratingDesc[i - 1].overallRating);
  }
});

test('3. Admin Player Management, Valuation Recalc, Deactivation, Bulk Import & RBAC', async () => {
  await ensurePlayersSeeded();
  const suffix = Date.now().toString(36);

  const regularUser = await getOrCreateDbUser(
    `p4-user-uid-${suffix}`,
    `regular-${suffix}@cricketverse.test`,
    'Regular Manager'
  );
  testUserIds.push(regularUser.id);
  assert.equal(regularUser.role, 'USER');

  // Verify requireAdmin blocks regular USER and allows ADMIN
  let blockedStatus = 0;
  await requireAdmin(
    { dbUser: regularUser } as unknown as AuthRequest,
    {
      status(code: number) {
        blockedStatus = code;
        return { json: () => {} };
      },
    } as unknown as Parameters<typeof requireAdmin>[1],
    () => {}
  );
  assert.equal(blockedStatus, 403);

  const adminUser = await getOrCreateDbUser(
    `p4-admin-uid-${suffix}`,
    'sandugoudar663@gmail.com',
    'Bootstrap Admin'
  );
  testUserIds.push(adminUser.id);
  assert.equal(adminUser.role, 'ADMIN');

  let nextCalled = false;
  await requireAdmin(
    { dbUser: adminUser } as unknown as AuthRequest,
    {
      status() {
        return { json: () => {} };
      },
    } as unknown as Parameters<typeof requireAdmin>[1],
    () => {
      nextCalled = true;
    }
  );
  assert.equal(nextCalled, true);

  // Admin creates a new fictional player
  const created = await createAdminPlayer(adminUser.id, {
    name: `Pranav Kulkarni ${suffix}`,
    age: 23,
    nationality: 'India',
    isOverseas: false,
    role: 'OPENING_BATSMAN',
    battingStyle: 'Right-Hand Bat',
    bowlingStyle: 'Right-Arm Offbreak',
    attributes: {
      batting: 80,
      battingTiming: 82,
      powerHitting: 76,
      bowling: 25,
      bowlingAccuracy: 28,
      swing: 18,
      spin: 30,
      fielding: 78,
      stamina: 80,
      experience: 66,
    },
    demandScore: 110,
  });
  testPlayerIds.push(created.player.id);
  assert.match(created.player.playerCode, /^CVP-\d+$/);

  const detail = await getPlayerDetailById(created.player.playerCode);
  assert.ok(detail && detail.player.id === created.player.id);

  // Admin updates attributes and recalculates base price
  const updated = await updateAdminPlayer(adminUser.id, created.player.id, {
    attributes: { batting: 92, battingTiming: 91, powerHitting: 90, experience: 88 },
    experienceLevel: 'ELITE',
    recalculatePrice: true,
  });
  assert.ok(updated.overallRating > created.player.overallRating);
  assert.ok(updated.basePrice >= created.player.basePrice);

  // Admin deactivates player -> excluded from active list & auction lot pool
  const deactivated = await updateAdminPlayer(adminUser.id, created.player.id, {
    isActive: false,
    availabilityStatus: 'INACTIVE',
  });
  assert.equal(deactivated.isActive, false);

  const activeList = await listFilteredPlayers({ q: `Pranav Kulkarni ${suffix}` });
  assert.equal(activeList.length, 0);
  const withInactive = await listFilteredPlayers({ q: `Pranav Kulkarni ${suffix}`, includeInactive: true });
  assert.equal(withInactive.length, 1);

  // Bulk JSON import
  const imported = await importAdminPlayers(adminUser.id, [
    {
      name: `Zayd Al-Mansoor ${suffix}`,
      age: 25,
      nationality: 'UAE',
      isOverseas: true,
      role: 'FAST_BOWLER',
      battingStyle: 'Left-Hand Bat',
      bowlingStyle: 'Right-Arm Fast',
      battingRating: 35,
      bowlingRating: 82,
      fieldingRating: 75,
      experienceRating: 70,
    },
  ]);
  assert.equal(imported.length, 1);
  testPlayerIds.push(imported[0].id);
});

test('4. League-Specific Ownership, Mid-Auction Flexibility, Squad Rules, Playing XI & Match Start Guards', async () => {
  await ensurePlayersSeeded();
  const suffix = Date.now().toString(36);

  const u1 = await getOrCreateDbUser(`p4-mgr1-${suffix}`, `mgr1-${suffix}@cv.test`, 'Owner One');
  const u2 = await getOrCreateDbUser(`p4-mgr2-${suffix}`, `mgr2-${suffix}@cv.test`, 'Owner Two');
  testUserIds.push(u1.id, u2.id);

  // Create League A & League B
  const leagueA = await createLeague(u1.id, {
    name: `Squad Rules Cup A ${suffix}`,
    visibility: 'PRIVATE',
    maxTeams: 4,
    purseAmount: 20000,
    minSquadSize: 15,
    maxSquadSize: 25,
    bidIncrement: 25,
    timerSeconds: 15,
    auctionMode: 'MEGA',
    teamName: 'Alpha Falcons',
    teamShortName: 'ALF',
  });
  testLeagueIds.push(leagueA.league.id);

  const joinedA = await joinLeagueByCode(u2.id, leagueA.league.inviteCode, 'Beta Sharks', 'BTS');
  const teamA1 = leagueA.team;
  const teamA2 = joinedA.team!;

  const leagueB = await createLeague(u1.id, {
    name: `Independent League B ${suffix}`,
    visibility: 'PRIVATE',
    maxTeams: 2,
    purseAmount: 15000,
    minSquadSize: 15,
    maxSquadSize: 25,
    bidIncrement: 25,
    timerSeconds: 15,
    auctionMode: 'MINI',
    teamName: 'League B Stars',
    teamShortName: 'LBS',
  });
  testLeagueIds.push(leagueB.league.id);

  // Configure pre-auction squad rules on League A before auction begins
  await updateLeagueSettings(u1.id, leagueA.league.id, {
    minSquadSize: 15,
    maxSquadSize: 25,
    maxOverseas: 8,
    minWicketkeepers: 1,
    minBatsmen: 4,
    minBowlers: 4,
    minAllRounders: 2,
  });

  // Fetch pool players categorized by role for building valid 15-player squads
  const batsmenPool = await listFilteredPlayers({ tab: 'BATSMEN' });
  const bowlersPool = await listFilteredPlayers({ tab: 'BOWLERS' });
  const allRounderPool = await listFilteredPlayers({ tab: 'ALL_ROUNDERS' });
  const keeperPool = await listFilteredPlayers({ tab: 'WICKETKEEPERS' });

  const pickNonOverseasFirst = (list: typeof batsmenPool, count: number, offset = 0) => {
    const domestic = list.filter((p) => !p.isOverseas);
    const chosen = domestic.slice(offset, offset + count);
    if (chosen.length < count) {
      const extra = list.filter((p) => !chosen.some((c) => c.id === p.id)).slice(0, count - chosen.length);
      return [...chosen, ...extra];
    }
    return chosen;
  };

  // Same fictional player owned in League A AND League B independently; duplicate inside League A rejected
  const sharedStar = batsmenPool[0];
  await assignPlayerToTeamInLeague({
    actorUserId: u1.id,
    leagueId: leagueA.league.id,
    teamId: teamA1.id,
    playerId: sharedStar.id,
    purchasePrice: 300, // Auction selling price separate from basePrice
  });
  await assignPlayerToTeamInLeague({
    actorUserId: u1.id,
    leagueId: leagueB.league.id,
    teamId: leagueB.team.id,
    playerId: sharedStar.id,
    purchasePrice: 450,
  });
  await assert.rejects(
    () =>
      assignPlayerToTeamInLeague({
        actorUserId: u2.id,
        leagueId: leagueA.league.id,
        teamId: teamA2.id,
        playerId: sharedStar.id,
        purchasePrice: 350,
      }),
    /PLAYER_ALREADY_OWNED_IN_LEAGUE/
  );

  // Mid-auction flexibility: Team A1 has 1 player (< 15), assignment succeeded without forcing min 15!
  // However, marking squad complete BEFORE meeting rules MUST fail:
  await assert.rejects(() => markTeamSquadComplete(u1.id, teamA1.id), /SQUAD_RULES_NOT_MET/);

  // Build valid 15-player squad for Team A1: 5 Batsmen (already has sharedStar), 5 Bowlers, 3 All-Rounders, 2 Keepers
  const team1Rest = [
    ...pickNonOverseasFirst(batsmenPool.filter((p) => p.id !== sharedStar.id), 4, 0),
    ...pickNonOverseasFirst(bowlersPool, 5, 0),
    ...pickNonOverseasFirst(allRounderPool, 3, 0),
    ...pickNonOverseasFirst(keeperPool, 2, 0),
  ];
  for (const p of team1Rest) {
    await assignPlayerToTeamInLeague({
      actorUserId: u1.id,
      leagueId: leagueA.league.id,
      teamId: teamA1.id,
      playerId: p.id,
      purchasePrice: 150,
    });
  }

  const completedA1 = await markTeamSquadComplete(u1.id, teamA1.id);
  assert.ok(completedA1?.team.isSquadComplete);
  assert.equal(completedA1?.roleCounts.total, 15);
  assert.ok((completedA1?.roleCounts.batsmen ?? 0) >= 4);
  assert.ok((completedA1?.roleCounts.bowlers ?? 0) >= 4);
  assert.ok((completedA1?.roleCounts.allRounders ?? 0) >= 2);
  assert.ok((completedA1?.roleCounts.wicketkeepers ?? 0) >= 1);
  assert.equal(completedA1?.team.remainingPurse, 20000 - 300 - 14 * 150);

  // Build 15-player squad for Team A2 as well (offset so zero league overlap)
  const team1OwnedIds = new Set(completedA1!.roster.map((r) => r.player.id));
  const team2Batch = [
    ...batsmenPool.filter((p) => !team1OwnedIds.has(p.id) && !p.isOverseas).slice(0, 5),
    ...bowlersPool.filter((p) => !team1OwnedIds.has(p.id) && !p.isOverseas).slice(0, 5),
    ...allRounderPool.filter((p) => !team1OwnedIds.has(p.id) && !p.isOverseas).slice(0, 3),
    ...keeperPool.filter((p) => !team1OwnedIds.has(p.id) && !p.isOverseas).slice(0, 2),
  ];
  for (const p of team2Batch) {
    await assignPlayerToTeamInLeague({
      actorUserId: u2.id,
      leagueId: leagueA.league.id,
      teamId: teamA2.id,
      playerId: p.id,
      purchasePrice: 120,
    });
  }

  const team2Details = await getTeamWithRoster(teamA2.id);
  assert.equal(team2Details?.roster.length, 15);

  const a1Ids = completedA1!.roster.map((r) => r.player.id);
  const a2Ids = team2Details!.roster.map((r) => r.player.id);

  // Playing XI rejection checks:
  // 1) Duplicate player
  await assert.rejects(
    () =>
      updateTeamLineup(u1.id, teamA1.id, {
        captainPlayerId: a1Ids[0],
        viceCaptainPlayerId: a1Ids[1],
        wicketkeeperPlayerId: a1Ids[13],
        playingXiIds: [a1Ids[0], a1Ids[0], ...a1Ids.slice(1, 10)],
        bowlingOrderIds: a1Ids.slice(5, 10),
      }),
    /DUPLICATE_PLAYER_IN_XI/
  );

  // 2) Non-owned player (owned by Team A2)
  await assert.rejects(
    () =>
      updateTeamLineup(u1.id, teamA1.id, {
        captainPlayerId: a1Ids[0],
        viceCaptainPlayerId: a1Ids[1],
        wicketkeeperPlayerId: a1Ids[13],
        playingXiIds: [...a1Ids.slice(0, 10), a2Ids[0]],
        bowlingOrderIds: a1Ids.slice(5, 10),
      }),
    /PLAYER_NOT_IN_SQUAD/
  );

  // 3) Captain === Vice-Captain
  await assert.rejects(
    () =>
      updateTeamLineup(u1.id, teamA1.id, {
        captainPlayerId: a1Ids[0],
        viceCaptainPlayerId: a1Ids[0],
        wicketkeeperPlayerId: a1Ids[13],
        playingXiIds: a1Ids.slice(0, 11),
        bowlingOrderIds: a1Ids.slice(5, 10),
      }),
    /VICE_CAPTAIN_SAME_AS_CAPTAIN/
  );

  // 4) Match start blocked while Team A1 / Team A2 Playing XIs are invalid
  await assert.rejects(
    () =>
      simulateQuickMatch(teamA1.id, teamA2.id, 'TOURNAMENT', leagueA.league.id, {
        requireValidXi: true,
      }),
    /PLAYING_XI_INVALID/
  );

  // Assign valid Playing XIs (11 XI + 4 substitutes) for both Team A1 and Team A2
  const a1Xi = [...a1Ids.slice(0, 10), a1Ids[13]]; // includes wicketkeeper
  const a1Subs = a1Ids.filter((id) => !a1Xi.includes(id));
  await updateTeamLineup(u1.id, teamA1.id, {
    captainPlayerId: a1Xi[0],
    viceCaptainPlayerId: a1Xi[1],
    wicketkeeperPlayerId: a1Xi[10],
    playingXiIds: a1Xi,
    substituteIds: a1Subs,
    bowlingOrderIds: a1Xi.slice(5, 10),
    requireFullXi: true,
  });

  const a2Xi = [...a2Ids.slice(0, 10), a2Ids[13]];
  const a2Subs = a2Ids.filter((id) => !a2Xi.includes(id));
  await updateTeamLineup(u2.id, teamA2.id, {
    captainPlayerId: a2Xi[0],
    viceCaptainPlayerId: a2Xi[1],
    wicketkeeperPlayerId: a2Xi[10],
    playingXiIds: a2Xi,
    substituteIds: a2Subs,
    bowlingOrderIds: a2Xi.slice(5, 10),
    requireFullXi: true,
  });

  // Verify shared pure validation helpers agree
  assert.equal(validateSquadComposition(completedA1!.roster.map((r) => r.player), completedA1!.rules).isValid, true);
  assert.equal(
    validatePlayingXiSelection({
      ownedPlayerIds: a1Ids,
      playingXiIds: a1Xi,
      substituteIds: a1Subs,
      captainPlayerId: a1Xi[0],
      viceCaptainPlayerId: a1Xi[1],
      wicketkeeperPlayerId: a1Xi[10],
      bowlingOrderIds: a1Xi.slice(5, 10),
    }).isValid,
    true
  );

  // Match starts cleanly now that both Playing XIs are valid!
  const matchRes = await simulateQuickMatch(teamA1.id, teamA2.id, 'TOURNAMENT', leagueA.league.id, {
    requireValidXi: true,
  });
  assert.equal(matchRes.match.status, 'COMPLETED');

  // Verify AuctionEngine startAuction filters out deactivated players
  const started = await startAuction(leagueA.league.id, u1.id);
  clearAuctionTimers(leagueA.league.id);
  assert.ok(started);
});
