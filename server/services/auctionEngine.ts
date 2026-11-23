import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/index.ts';
import {
  auctionBids,
  auctionEvents,
  auctionLots,
  auctionResults,
  auctions,
  auditLogs,
  leagueMembers,
  leagues,
  leagueSettings,
  players,
  teamPlayers,
  teams,
  userProfiles,
  users,
} from '../../src/db/schema.ts';
import { logEvent } from '../lib/logger.ts';

export type AuctionState =
  | 'CREATED'
  | 'WAITING'
  | 'LIVE'
  | 'BIDDING'
  | 'AWAITING_FINALIZATION'
  | 'SOLD'
  | 'UNSOLD'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED';

export type PlayerOrderMode = 'RANDOM' | 'ROLE_BASED' | 'ADMIN_DEFINED' | 'MANUAL';

// Per-league async mutex queue to serialize state transitions and bids safely
const leagueLocks = new Map<string, Promise<unknown>>();

export async function withAuctionLock<T>(leagueId: string, fn: () => Promise<T>): Promise<T> {
  const prev = leagueLocks.get(leagueId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  leagueLocks.set(leagueId, prev.then(() => next));

  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (leagueLocks.get(leagueId) === next) {
      leagueLocks.delete(leagueId);
    }
  }
}

export interface AuctionBroadcastEmitter {
  emitToLeague(leagueId: string, event: string, payload: unknown): void;
}

let socketEmitter: AuctionBroadcastEmitter | null = null;
export function registerAuctionEmitter(emitter: AuctionBroadcastEmitter) {
  socketEmitter = emitter;
}

function emit(leagueId: string, event: string, payload: unknown) {
  if (socketEmitter) {
    socketEmitter.emitToLeague(leagueId, event, payload);
  }
}

export function computeMinimumBidIncrement(
  currentBid: number,
  config: {
    useTieredIncrements?: boolean | null;
    bidIncrement?: number | null;
    tier1Increment?: number | null;
    tier2Increment?: number | null;
    tier3Increment?: number | null;
  }
): number {
  const useTiered = config.useTieredIncrements !== false;
  if (!useTiered) {
    return Math.max(1, config.bidIncrement ?? 25);
  }
  if (currentBid < 100) {
    return Math.max(1, config.tier1Increment ?? 5);
  }
  if (currentBid <= 500) {
    return Math.max(1, config.tier2Increment ?? 10);
  }
  return Math.max(1, config.tier3Increment ?? 25);
}

async function isOwnerOrAdmin(
  txOrDb: typeof db,
  actorUserId: string,
  leagueOwnerId: string
): Promise<boolean> {
  if (actorUserId === leagueOwnerId) return true;
  const [userRow] = await txOrDb
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, actorUserId))
    .limit(1);
  return userRow?.role === 'ADMIN';
}

export async function getAuctionSnapshot(leagueId: string) {
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (!league) return null;

  const [auction] = await db.select().from(auctions).where(eq(auctions.leagueId, leagueId)).limit(1);
  if (!auction) return null;

  const [settings] = await db
    .select()
    .from(leagueSettings)
    .where(eq(leagueSettings.leagueId, leagueId))
    .limit(1);

  const leagueTeamsRaw = await db
    .select({
      id: teams.id,
      leagueId: teams.leagueId,
      ownerId: teams.ownerId,
      name: teams.name,
      shortName: teams.shortName,
      primaryColor: teams.primaryColor,
      logoUrl: teams.logoUrl,
      totalPurse: teams.totalPurse,
      remainingPurse: teams.remainingPurse,
      squadCount: teams.squadCount,
      ownerName: userProfiles.displayName,
      ownerPlayerId: userProfiles.uniquePlayerId,
    })
    .from(teams)
    .leftJoin(userProfiles, eq(teams.ownerId, userProfiles.userId))
    .where(eq(teams.leagueId, leagueId))
    .orderBy(asc(teams.createdAt));

  const leagueRosterRows = await db
    .select({
      teamId: teamPlayers.teamId,
      playerId: teamPlayers.playerId,
      purchasePrice: teamPlayers.purchasePrice,
      ownershipStatus: teamPlayers.ownershipStatus,
      playerCode: players.playerCode,
      playerName: players.name,
      playerRole: players.role,
      isOverseas: players.isOverseas,
      playerImage: players.imageUrl,
      overallRating: players.overallRating,
    })
    .from(teamPlayers)
    .innerJoin(players, eq(teamPlayers.playerId, players.id))
    .where(eq(teamPlayers.leagueId, leagueId))
    .orderBy(asc(teamPlayers.acquiredAt));

  const teamStatsMap = new Map<
    string,
    {
      overseasCount: number;
      batsmenCount: number;
      bowlersCount: number;
      allRoundersCount: number;
      wicketkeepersCount: number;
      purchasedPlayers: Array<{
        playerId: string;
        playerCode: string;
        name: string;
        role: string;
        isOverseas: boolean;
        purchasePrice: number;
        imageUrl: string;
        overallRating: number;
      }>;
    }
  >();

  for (const row of leagueRosterRows) {
    if (row.ownershipStatus !== 'OWNED') continue;
    let entry = teamStatsMap.get(row.teamId);
    if (!entry) {
      entry = {
        overseasCount: 0,
        batsmenCount: 0,
        bowlersCount: 0,
        allRoundersCount: 0,
        wicketkeepersCount: 0,
        purchasedPlayers: [],
      };
      teamStatsMap.set(row.teamId, entry);
    }
    if (row.isOverseas) entry.overseasCount += 1;
    if (
      row.playerRole === 'BATSMAN' ||
      row.playerRole === 'OPENING_BATSMAN' ||
      row.playerRole === 'MIDDLE_ORDER_BATSMAN'
    ) {
      entry.batsmenCount += 1;
    } else if (
      row.playerRole === 'BOWLER' ||
      row.playerRole === 'FAST_BOWLER' ||
      row.playerRole === 'SPIN_BOWLER'
    ) {
      entry.bowlersCount += 1;
    } else if (row.playerRole === 'ALL_ROUNDER') {
      entry.allRoundersCount += 1;
    } else if (row.playerRole === 'WICKETKEEPER') {
      entry.wicketkeepersCount += 1;
    }
    entry.purchasedPlayers.push({
      playerId: row.playerId,
      playerCode: row.playerCode,
      name: row.playerName,
      role: row.playerRole,
      isOverseas: row.isOverseas,
      purchasePrice: row.purchasePrice,
      imageUrl: row.playerImage,
      overallRating: row.overallRating,
    });
  }

  const leagueTeams = leagueTeamsRaw.map((t) => {
    const stats = teamStatsMap.get(t.id);
    return {
      ...t,
      totalSpent: Math.max(0, t.totalPurse - t.remainingPurse),
      availableSlots: Math.max(0, league.maxSquadSize - t.squadCount),
      overseasCount: stats?.overseasCount ?? 0,
      batsmenCount: stats?.batsmenCount ?? 0,
      bowlersCount: stats?.bowlersCount ?? 0,
      allRoundersCount: stats?.allRoundersCount ?? 0,
      wicketkeepersCount: stats?.wicketkeepersCount ?? 0,
      purchasedPlayers: stats?.purchasedPlayers ?? [],
    };
  });

  const teamLookup = new Map(leagueTeams.map((t) => [t.id, t]));

  let currentPlayer = null;
  let currentLot = null;

  if (auction.currentLotId) {
    const [lot] = await db
      .select()
      .from(auctionLots)
      .where(eq(auctionLots.id, auction.currentLotId))
      .limit(1);
    currentLot = lot ?? null;
  }

  if (auction.currentPlayerId) {
    const [player] = await db
      .select()
      .from(players)
      .where(eq(players.id, auction.currentPlayerId))
      .limit(1);
    currentPlayer = player ?? null;
  }

  const recentEvents = await db
    .select()
    .from(auctionEvents)
    .where(eq(auctionEvents.auctionId, auction.id))
    .orderBy(desc(auctionEvents.createdAt))
    .limit(40);

  const recentBidsRaw = await db
    .select()
    .from(auctionBids)
    .where(eq(auctionBids.auctionId, auction.id))
    .orderBy(desc(auctionBids.createdAt))
    .limit(50);

  const bids = recentBidsRaw.map((b) => {
    const tm = teamLookup.get(b.teamId);
    return {
      ...b,
      teamName: tm?.name ?? 'Team',
      teamShortName: tm?.shortName ?? 'TM',
      teamColor: tm?.primaryColor ?? '#D4AF37',
      bidderName: tm?.ownerName ?? 'Owner',
    };
  });

  const history = await db
    .select({
      id: auctionResults.id,
      status: auctionResults.status,
      finalPrice: auctionResults.finalPrice,
      finalizedAt: auctionResults.finalizedAt,
      playerId: players.id,
      playerName: players.name,
      playerRole: players.role,
      playerCategory: players.category,
      playerImage: players.imageUrl,
      winningTeamId: teams.id,
      winningTeamName: teams.name,
      winningTeamShort: teams.shortName,
      winningTeamColor: teams.primaryColor,
    })
    .from(auctionResults)
    .innerJoin(players, eq(auctionResults.playerId, players.id))
    .leftJoin(teams, eq(auctionResults.winningTeamId, teams.id))
    .where(eq(auctionResults.auctionId, auction.id))
    .orderBy(desc(auctionResults.finalizedAt))
    .limit(100);

  const queuedLots = await db
    .select({
      id: auctionLots.id,
      lotNumber: auctionLots.lotNumber,
      roundNumber: auctionLots.roundNumber,
      basePrice: auctionLots.basePrice,
      playerName: players.name,
      playerRole: players.role,
      playerCategory: players.category,
      isOverseas: players.isOverseas,
      overallRating: players.overallRating,
    })
    .from(auctionLots)
    .innerJoin(players, eq(auctionLots.playerId, players.id))
    .where(and(eq(auctionLots.auctionId, auction.id), eq(auctionLots.status, 'QUEUED')))
    .orderBy(asc(auctionLots.lotNumber))
    .limit(12);

  const allLots = await db
    .select({
      id: auctionLots.id,
      status: auctionLots.status,
    })
    .from(auctionLots)
    .where(eq(auctionLots.auctionId, auction.id));

  const unsoldCount = allLots.filter((l) => l.status === 'UNSOLD').length;
  const soldCount = allLots.filter((l) => l.status === 'SOLD').length;
  const queuedCount = allLots.filter((l) => l.status === 'QUEUED').length;

  const effectiveTimerSeconds = auction.timerSeconds || league.timerSeconds || 20;
  const activeBidRef = auction.currentBid ?? 0;
  const nextIncrement =
    auction.currentBid === null
      ? 0
      : computeMinimumBidIncrement(activeBidRef, {
          useTieredIncrements: auction.useTieredIncrements,
          bidIncrement: league.bidIncrement,
          tier1Increment: auction.tier1Increment,
          tier2Increment: auction.tier2Increment,
          tier3Increment: auction.tier3Increment,
        });

  return {
    serverNow: Date.now(),
    league: {
      ...league,
      effectiveTimerSeconds,
    },
    settings: settings ?? null,
    auction: {
      ...auction,
      name: auction.name || `${league.name} Auction`,
      timerSeconds: effectiveTimerSeconds,
      settingsLocked: auction.state !== 'WAITING' && auction.state !== 'CREATED',
      unsoldCount,
      soldCount,
      queuedCount,
      nextIncrement,
    },
    currentLot,
    currentPlayer,
    teams: leagueTeams,
    bids,
    recentEvents,
    history,
    upNext: queuedLots,
  };
}

export async function listAuctionDashboard(userId: string) {
  const memberships = await db
    .select({ leagueId: leagueMembers.leagueId })
    .from(leagueMembers)
    .where(eq(leagueMembers.userId, userId));
  const myLeagueIdSet = new Set(memberships.map((m) => m.leagueId));

  const myLeagues =
    memberships.length > 0
      ? await db.select().from(leagues).where(inArray(leagues.id, Array.from(myLeagueIdSet)))
      : [];
  const publicLeagues = await db
    .select()
    .from(leagues)
    .where(eq(leagues.visibility, 'PUBLIC'))
    .limit(40);

  const leagueMap = new Map<string, typeof leagues.$inferSelect>();
  for (const l of [...myLeagues, ...publicLeagues]) {
    leagueMap.set(l.id, l);
  }
  const allLeagues = Array.from(leagueMap.values());
  const allLeagueIds = allLeagues.map((l) => l.id);

  const allAuctions =
    allLeagueIds.length > 0
      ? await db.select().from(auctions).where(inArray(auctions.leagueId, allLeagueIds))
      : [];
  const auctionByLeague = new Map(allAuctions.map((a) => [a.leagueId, a]));

  const allSettings =
    allLeagueIds.length > 0
      ? await db.select().from(leagueSettings).where(inArray(leagueSettings.leagueId, allLeagueIds))
      : [];
  const settingsByLeague = new Map(allSettings.map((s) => [s.leagueId, s]));

  const allTeams =
    allLeagueIds.length > 0
      ? await db
          .select({
            id: teams.id,
            leagueId: teams.leagueId,
            ownerId: teams.ownerId,
            name: teams.name,
            shortName: teams.shortName,
            primaryColor: teams.primaryColor,
            remainingPurse: teams.remainingPurse,
            squadCount: teams.squadCount,
            ownerName: userProfiles.displayName,
            ownerPlayerId: userProfiles.uniquePlayerId,
          })
          .from(teams)
          .leftJoin(userProfiles, eq(teams.ownerId, userProfiles.userId))
          .where(inArray(teams.leagueId, allLeagueIds))
      : [];

  const teamsByLeague = new Map<string, typeof allTeams>();
  for (const t of allTeams) {
    const arr = teamsByLeague.get(t.leagueId) || [];
    arr.push(t);
    teamsByLeague.set(t.leagueId, arr);
  }

  const activePlayers = await db.select({ id: players.id, isActive: players.isActive, availabilityStatus: players.availabilityStatus }).from(players);
  const totalActivePlayers = activePlayers.filter(
    (p) => p.isActive !== false && p.availabilityStatus !== 'INACTIVE'
  ).length;

  const auctionIds = allAuctions.map((a) => a.id);
  const allLotCounts =
    auctionIds.length > 0
      ? await db
          .select({ auctionId: auctionLots.auctionId, status: auctionLots.status })
          .from(auctionLots)
          .where(inArray(auctionLots.auctionId, auctionIds))
      : [];
  const lotStatsByAuction = new Map<string, { total: number; sold: number; unsold: number }>();
  for (const l of allLotCounts) {
    const cur = lotStatsByAuction.get(l.auctionId) || { total: 0, sold: 0, unsold: 0 };
    cur.total += 1;
    if (l.status === 'SOLD') cur.sold += 1;
    if (l.status === 'UNSOLD') cur.unsold += 1;
    lotStatsByAuction.set(l.auctionId, cur);
  }

  const items = allLeagues
    .map((league) => {
      const auction = auctionByLeague.get(league.id);
      if (!auction) return null;
      const leagueTeams = teamsByLeague.get(league.id) || [];
      const settings = settingsByLeague.get(league.id);
      const lotStats = lotStatsByAuction.get(auction.id);
      const defaultLimit =
        auction.playerPoolLimit ??
        (league.auctionMode === 'FAST_TRACK' ? 30 : league.auctionMode === 'MINI' ? 60 : totalActivePlayers);
      const totalPlayersAvailable =
        lotStats && lotStats.total > 0
          ? lotStats.total
          : Math.min(totalActivePlayers, defaultLimit);
      const ownerTeam = leagueTeams.find((t) => t.ownerId === league.ownerId);

      return {
        auctionId: auction.id,
        leagueId: league.id,
        auctionName: auction.name || `${league.name} Auction`,
        leagueName: league.name,
        inviteCode: league.inviteCode,
        visibility: league.visibility,
        leagueStatus: league.status,
        auctionState: auction.state as AuctionState,
        participatingTeamsCount: leagueTeams.length,
        maxTeams: league.maxTeams,
        totalPlayersAvailable,
        soldPlayersCount: lotStats?.sold ?? 0,
        unsoldPlayersCount: lotStats?.unsold ?? 0,
        roundNumber: auction.roundNumber,
        scheduledStartAt: auction.scheduledStartAt ? auction.scheduledStartAt.toISOString() : null,
        startedAt: auction.startedAt ? auction.startedAt.toISOString() : null,
        completedAt: auction.completedAt ? auction.completedAt.toISOString() : null,
        isMember: myLeagueIdSet.has(league.id),
        isOwner: league.ownerId === userId,
        ownerName: ownerTeam?.ownerName || 'League Owner',
        settingsLocked: auction.state !== 'CREATED' && auction.state !== 'WAITING',
        participatingOwners: leagueTeams.map((t) => ({
          userId: t.ownerId,
          displayName: t.ownerName || 'Franchise Owner',
          uniquePlayerId: t.ownerPlayerId || null,
          teamName: t.name,
          teamShortName: t.shortName,
          primaryColor: t.primaryColor,
          remainingPurse: t.remainingPurse,
          squadCount: t.squadCount,
        })),
        config: {
          purseAmount: league.purseAmount,
          minSquadSize: league.minSquadSize,
          maxSquadSize: league.maxSquadSize,
          maxOverseas: settings?.maxOverseas ?? 8,
          minBatsmen: settings?.minBatsmen ?? 4,
          minBowlers: settings?.minBowlers ?? 4,
          minAllRounders: settings?.minAllRounders ?? 2,
          minWicketkeepers: settings?.minWicketkeepers ?? 1,
          bidIncrement: league.bidIncrement,
          useTieredIncrements: auction.useTieredIncrements,
          tier1Increment: auction.tier1Increment,
          tier2Increment: auction.tier2Increment,
          tier3Increment: auction.tier3Increment,
          timerSeconds: auction.timerSeconds || league.timerSeconds || 20,
          maxTimerExtensions: auction.maxTimerExtensions,
          playerOrderMode: auction.playerOrderMode as PlayerOrderMode,
          manualPlayerIds: (auction.manualPlayerIds as string[] | null) || null,
          basePriceOverrides: (auction.basePriceOverrides as Record<string, number> | null) || null,
          playerPoolLimit: auction.playerPoolLimit,
          enableSecondRound: auction.enableSecondRound,
          allowSkipPlayer: auction.allowSkipPlayer,
          auctionMode: league.auctionMode,
        },
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => {
      const rank = (st: string) =>
        st === 'LIVE' || st === 'BIDDING'
          ? 0
          : st === 'PAUSED'
          ? 1
          : st === 'WAITING' || st === 'CREATED'
          ? 2
          : st === 'COMPLETED'
          ? 3
          : 4;
      return rank(a.auctionState) - rank(b.auctionState);
    });

  const live = items.filter((i) => ['LIVE', 'BIDDING', 'PAUSED', 'AWAITING_FINALIZATION'].includes(i.auctionState));
  const upcoming = items.filter((i) => ['CREATED', 'WAITING'].includes(i.auctionState) && i.leagueStatus !== 'CANCELLED');
  const completed = items.filter((i) => i.auctionState === 'COMPLETED');
  const joinable = items.filter(
    (i) =>
      !i.isMember &&
      ['CREATED', 'WAITING'].includes(i.auctionState) &&
      i.participatingTeamsCount < i.maxTeams &&
      i.leagueStatus !== 'CANCELLED'
  );

  // Recent auction outcomes across user's leagues
  const myAuctionIds = items.filter((i) => i.isMember).map((i) => i.auctionId);
  const recentResults =
    myAuctionIds.length > 0
      ? await db
          .select({
            id: auctionResults.id,
            auctionId: auctionResults.auctionId,
            leagueId: auctionResults.leagueId,
            status: auctionResults.status,
            finalPrice: auctionResults.finalPrice,
            finalizedAt: auctionResults.finalizedAt,
            playerName: players.name,
            playerRole: players.role,
            winningTeamName: teams.name,
            winningTeamShort: teams.shortName,
          })
          .from(auctionResults)
          .innerJoin(players, eq(auctionResults.playerId, players.id))
          .leftJoin(teams, eq(auctionResults.winningTeamId, teams.id))
          .where(inArray(auctionResults.auctionId, myAuctionIds))
          .orderBy(desc(auctionResults.finalizedAt))
          .limit(60)
      : [];

  const history = completed.map((c) => ({
    ...c,
    results: recentResults.filter((r) => r.auctionId === c.auctionId),
  }));

  return {
    auctions: items,
    live,
    upcoming,
    completed,
    joinable,
    history,
    recentResults,
  };
}

export interface ConfigureAuctionInput {
  name?: string;
  purseAmount?: number;
  minSquadSize?: number;
  maxSquadSize?: number;
  maxOverseas?: number;
  minBatsmen?: number;
  minBowlers?: number;
  minAllRounders?: number;
  minWicketkeepers?: number;
  bidIncrement?: number;
  useTieredIncrements?: boolean;
  tier1Increment?: number;
  tier2Increment?: number;
  tier3Increment?: number;
  timerSeconds?: number;
  maxTimerExtensions?: number | null;
  playerOrderMode?: PlayerOrderMode;
  manualPlayerIds?: string[] | null;
  basePriceOverrides?: Record<string, number> | null;
  playerPoolLimit?: number | null;
  enableSecondRound?: boolean;
  allowSkipPlayer?: boolean;
  scheduledStartAt?: string | null;
  auctionMode?: 'MEGA' | 'MINI' | 'FAST_TRACK';
}

export async function configureAuction(
  leagueId: string,
  actorUserId: string,
  input: ConfigureAuctionInput
) {
  return withAuctionLock(leagueId, async () => {
    await db.transaction(async (tx) => {
      const [league] = await tx
        .select()
        .from(leagues)
        .where(eq(leagues.id, leagueId))
        .for('update')
        .limit(1);
      if (!league) throw new Error('LEAGUE_NOT_FOUND');

      const allowed = await isOwnerOrAdmin(tx as unknown as typeof db, actorUserId, league.ownerId);
      if (!allowed) throw new Error('FORBIDDEN_OWNER_ONLY');

      const [auction] = await tx
        .select()
        .from(auctions)
        .where(eq(auctions.leagueId, leagueId))
        .for('update')
        .limit(1);
      if (!auction) throw new Error('AUCTION_NOT_FOUND');

      if (auction.state !== 'WAITING' && auction.state !== 'CREATED') {
        throw new Error('AUCTION_SETTINGS_LOCKED');
      }

      const nextMinSquad = input.minSquadSize ?? league.minSquadSize;
      const nextMaxSquad = input.maxSquadSize ?? league.maxSquadSize;
      if (nextMaxSquad < nextMinSquad || nextMinSquad < 1 || nextMaxSquad > 25) {
        throw new Error('INVALID_SQUAD_RANGE');
      }

      const nextPurse = input.purseAmount ?? league.purseAmount;
      if (!Number.isInteger(nextPurse) || nextPurse < 500 || nextPurse > 100000) {
        throw new Error('INVALID_PURSE_AMOUNT');
      }

      const nextTimer = input.timerSeconds ?? auction.timerSeconds ?? league.timerSeconds ?? 20;
      if (!Number.isInteger(nextTimer) || nextTimer < 5 || nextTimer > 120) {
        throw new Error('INVALID_TIMER_SECONDS');
      }

      await tx
        .update(leagues)
        .set({
          purseAmount: nextPurse,
          minSquadSize: nextMinSquad,
          maxSquadSize: nextMaxSquad,
          bidIncrement: input.bidIncrement ?? league.bidIncrement,
          timerSeconds: nextTimer,
          auctionMode: input.auctionMode ?? league.auctionMode,
          updatedAt: new Date(),
        })
        .where(eq(leagues.id, leagueId));

      const [existingSettings] = await tx
        .select()
        .from(leagueSettings)
        .where(eq(leagueSettings.leagueId, leagueId))
        .limit(1);

      if (existingSettings) {
        await tx
          .update(leagueSettings)
          .set({
            maxOverseas: input.maxOverseas ?? existingSettings.maxOverseas,
            minBatsmen: input.minBatsmen ?? existingSettings.minBatsmen,
            minBowlers: input.minBowlers ?? existingSettings.minBowlers,
            minAllRounders: input.minAllRounders ?? existingSettings.minAllRounders,
            minWicketkeepers: input.minWicketkeepers ?? existingSettings.minWicketkeepers,
          })
          .where(eq(leagueSettings.leagueId, leagueId));
      }

      if (nextPurse !== league.purseAmount) {
        await tx
          .update(teams)
          .set({ totalPurse: nextPurse, remainingPurse: nextPurse })
          .where(and(eq(teams.leagueId, leagueId), eq(teams.squadCount, 0)));
      }

      let parsedSchedule: Date | null | undefined = undefined;
      if (input.scheduledStartAt !== undefined) {
        parsedSchedule = input.scheduledStartAt ? new Date(input.scheduledStartAt) : null;
      }

      await tx
        .update(auctions)
        .set({
          name: input.name !== undefined ? input.name.trim().slice(0, 80) || `${league.name} Auction` : auction.name,
          timerSeconds: nextTimer,
          maxTimerExtensions:
            input.maxTimerExtensions !== undefined ? input.maxTimerExtensions : auction.maxTimerExtensions,
          useTieredIncrements: input.useTieredIncrements ?? auction.useTieredIncrements,
          tier1Increment: input.tier1Increment ?? auction.tier1Increment,
          tier2Increment: input.tier2Increment ?? auction.tier2Increment,
          tier3Increment: input.tier3Increment ?? auction.tier3Increment,
          playerOrderMode: input.playerOrderMode ?? auction.playerOrderMode,
          manualPlayerIds:
            input.manualPlayerIds !== undefined ? input.manualPlayerIds : auction.manualPlayerIds,
          basePriceOverrides:
            input.basePriceOverrides !== undefined ? input.basePriceOverrides : auction.basePriceOverrides,
          playerPoolLimit:
            input.playerPoolLimit !== undefined ? input.playerPoolLimit : auction.playerPoolLimit,
          enableSecondRound: input.enableSecondRound ?? auction.enableSecondRound,
          allowSkipPlayer: input.allowSkipPlayer ?? auction.allowSkipPlayer,
          ...(parsedSchedule !== undefined ? { scheduledStartAt: parsedSchedule } : {}),
          updatedAt: new Date(),
        })
        .where(eq(auctions.id, auction.id));

      await tx.insert(auctionEvents).values({
        auctionId: auction.id,
        actorUserId,
        eventType: 'AUCTION_CONFIGURED',
        payload: {
          purseAmount: nextPurse,
          timerSeconds: nextTimer,
          playerOrderMode: input.playerOrderMode ?? auction.playerOrderMode,
          useTieredIncrements: input.useTieredIncrements ?? auction.useTieredIncrements,
        },
      });
    });

    const snapshot = await getAuctionSnapshot(leagueId);
    emit(leagueId, 'auction:stateSync', snapshot);
    return snapshot;
  });
}

function buildOrderedPlayerPool(
  allPlayers: Array<typeof players.$inferSelect>,
  mode: string,
  manualPlayerIds: string[] | null | undefined,
  poolLimit: number | null | undefined,
  auctionMode: string
) {
  const categoryOrder: Record<string, number> = {
    MARQUEE: 1,
    CAPS: 2,
    DOMESTIC: 3,
    EMERGING: 4,
  };
  const roleOrder: Record<string, number> = {
    OPENING_BATSMAN: 1,
    BATSMAN: 2,
    MIDDLE_ORDER_BATSMAN: 3,
    WICKETKEEPER: 4,
    ALL_ROUNDER: 5,
    FAST_BOWLER: 6,
    SPIN_BOWLER: 7,
    BOWLER: 8,
  };

  let ordered = [...allPlayers];
  if (mode === 'RANDOM') {
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
  } else if (mode === 'ROLE_BASED') {
    ordered.sort((a, b) => {
      const rDiff = (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9);
      if (rDiff !== 0) return rDiff;
      return b.overallRating - a.overallRating || b.basePrice - a.basePrice;
    });
  } else if (mode === 'MANUAL' && Array.isArray(manualPlayerIds) && manualPlayerIds.length > 0) {
    const byId = new Map(allPlayers.map((p) => [p.id, p]));
    const picked: Array<typeof players.$inferSelect> = [];
    const seen = new Set<string>();
    for (const pid of manualPlayerIds) {
      const hit = byId.get(pid);
      if (hit && !seen.has(hit.id)) {
        picked.push(hit);
        seen.add(hit.id);
      }
    }
    ordered = picked.length > 0 ? picked : ordered;
  } else {
    // ADMIN_DEFINED default: Marquee -> Caps -> Domestic -> Emerging
    ordered.sort((a, b) => {
      const diff = (categoryOrder[a.category] ?? 9) - (categoryOrder[b.category] ?? 9);
      if (diff !== 0) return diff;
      return b.basePrice - a.basePrice;
    });
  }

  const effectiveLimit =
    poolLimit && poolLimit > 0
      ? poolLimit
      : auctionMode === 'FAST_TRACK'
      ? 30
      : auctionMode === 'MINI'
      ? 60
      : ordered.length;

  return ordered.slice(0, Math.min(ordered.length, effectiveLimit));
}

export async function startAuction(
  leagueId: string,
  actorUserId: string,
  options?: { requireAllReady?: boolean }
) {
  return withAuctionLock(leagueId, async () => {
    const result = await db.transaction(async (tx) => {
      const [league] = await tx
        .select()
        .from(leagues)
        .where(eq(leagues.id, leagueId))
        .for('update')
        .limit(1);

      if (!league) throw new Error('LEAGUE_NOT_FOUND');
      const allowed = await isOwnerOrAdmin(tx as unknown as typeof db, actorUserId, league.ownerId);
      if (!allowed) throw new Error('ONLY_OWNER_CAN_START');
      if (league.status === 'CANCELLED') throw new Error('LEAGUE_CANCELLED');
      if (league.status === 'COMPLETED') throw new Error('AUCTION_ALREADY_STARTED');

      const [auction] = await tx
        .select()
        .from(auctions)
        .where(eq(auctions.leagueId, leagueId))
        .for('update')
        .limit(1);

      if (!auction) throw new Error('AUCTION_NOT_FOUND');
      if (auction.state !== 'WAITING' && auction.state !== 'CREATED') {
        throw new Error('AUCTION_ALREADY_STARTED');
      }

      const joinedTeams = await tx.select().from(teams).where(eq(teams.leagueId, leagueId));
      if (joinedTeams.length < 2) {
        throw new Error('MIN_TWO_TEAMS_REQUIRED');
      }

      if (options?.requireAllReady) {
        const joinedMembers = await tx
          .select()
          .from(leagueMembers)
          .where(eq(leagueMembers.leagueId, leagueId));
        if (joinedMembers.length < 2 || joinedMembers.some((m) => !m.isReady)) {
          throw new Error('PARTICIPANTS_NOT_READY');
        }
      }

      const rawPlayers = await tx.select().from(players);
      const allPlayers = rawPlayers.filter(
        (p) => p.isActive !== false && p.availabilityStatus !== 'INACTIVE'
      );

      const pool = buildOrderedPlayerPool(
        allPlayers,
        auction.playerOrderMode,
        auction.manualPlayerIds as string[] | null,
        auction.playerPoolLimit,
        league.auctionMode
      );
      if (pool.length === 0) throw new Error('NO_PLAYERS_IN_DATABASE');

      const overrides = (auction.basePriceOverrides as Record<string, number> | null) || {};
      const minBaseFloor = Math.max(10, league.minBasePrice || 20);
      const lotInserts = pool.map((p, idx) => {
        const overrideVal = overrides[p.id];
        const basePrice =
          typeof overrideVal === 'number' && Number.isInteger(overrideVal) && overrideVal > 0
            ? Math.max(overrideVal, minBaseFloor)
            : Math.max(p.basePrice, minBaseFloor);
        return {
          auctionId: auction.id,
          playerId: p.id,
          lotNumber: idx + 1,
          roundNumber: 1,
          basePrice,
          status: idx === 0 ? 'ACTIVE' : 'QUEUED',
        };
      });

      const insertedLots = await tx.insert(auctionLots).values(lotInserts).returning();
      const firstLot = insertedLots[0];
      const firstPlayer = pool[0];
      const timerSec = auction.timerSeconds || league.timerSeconds || 20;
      const deadline = new Date(Date.now() + timerSec * 1000);

      await tx
        .update(auctions)
        .set({
          state: 'LIVE',
          currentLotId: firstLot.id,
          currentPlayerId: firstPlayer.id,
          currentBid: null,
          highestBidderTeamId: null,
          highestBidderUserId: null,
          lotDeadlineAt: deadline,
          lotOrder: 1,
          roundNumber: 1,
          timerExtensionsUsed: 0,
          totalLots: insertedLots.length,
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(auctions.id, auction.id));

      await tx
        .update(leagues)
        .set({ status: 'AUCTION_IN_PROGRESS', updatedAt: new Date() })
        .where(eq(leagues.id, leagueId));

      await tx.insert(auctionEvents).values([
        {
          auctionId: auction.id,
          actorUserId,
          eventType: 'AUCTION_STARTED',
          payload: { totalLots: insertedLots.length, teamsCount: joinedTeams.length, roundNumber: 1 },
        },
        {
          auctionId: auction.id,
          lotId: firstLot.id,
          actorUserId,
          eventType: 'LOT_OPENED',
          amount: firstLot.basePrice,
          payload: { playerName: firstPlayer.name, lotNumber: 1, roundNumber: 1 },
        },
      ]);

      await tx.insert(auditLogs).values({
        actorUserId,
        action: 'AUCTION_STARTED',
        resourceType: 'AUCTION',
        resourceId: auction.id,
        details: { leagueId, totalLots: insertedLots.length },
      });

      return { auctionId: auction.id, firstLot, firstPlayer, deadline };
    });

    scheduleAuctionDeadline(leagueId, result.deadline);
    const snapshot = await getAuctionSnapshot(leagueId);
    emit(leagueId, 'auction:started', snapshot);
    emit(leagueId, 'auction:player', snapshot);
    return snapshot;
  });
}

export interface PlaceBidInput {
  leagueId: string;
  userId: string;
  amount: number;
  idempotencyKey?: string;
}

export async function placeBid(input: PlaceBidInput) {
  const { leagueId, userId, amount, idempotencyKey } = input;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('INVALID_BID_AMOUNT');
  }

  return withAuctionLock(leagueId, async () => {
    const rejectContext: {
      auctionId?: string;
      lotId?: string;
      playerId?: string;
      teamId?: string;
    } = {};

    try {
      const txResult = await db.transaction(async (tx) => {
        const [league] = await tx
          .select()
          .from(leagues)
          .where(eq(leagues.id, leagueId))
          .limit(1);
        if (!league) throw new Error('LEAGUE_NOT_FOUND');

        const [membership] = await tx
          .select()
          .from(leagueMembers)
          .where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, userId)))
          .limit(1);
        if (!membership) throw new Error('NOT_LEAGUE_MEMBER');

        const [auction] = await tx
          .select()
          .from(auctions)
          .where(eq(auctions.leagueId, leagueId))
          .for('update')
          .limit(1);

        if (!auction) throw new Error('AUCTION_NOT_FOUND');
        rejectContext.auctionId = auction.id;

        if (idempotencyKey) {
          const [duplicateEvent] = await tx
            .select()
            .from(auctionEvents)
            .where(
              and(
                eq(auctionEvents.auctionId, auction.id),
                eq(auctionEvents.idempotencyKey, idempotencyKey)
              )
            )
            .limit(1);
          if (duplicateEvent) {
            return {
              idempotentDuplicate: true,
              auctionId: auction.id,
              amount: duplicateEvent.amount ?? amount,
            };
          }
        }

        if (auction.state !== 'LIVE' && auction.state !== 'BIDDING') {
          throw new Error('AUCTION_NOT_ACCEPTING_BIDS');
        }
        if (!auction.currentLotId || !auction.currentPlayerId) {
          throw new Error('NO_ACTIVE_LOT');
        }
        rejectContext.lotId = auction.currentLotId;
        rejectContext.playerId = auction.currentPlayerId;

        if (auction.lotDeadlineAt && auction.lotDeadlineAt.getTime() < Date.now()) {
          throw new Error('LOT_TIMER_EXPIRED');
        }

        const [lot] = await tx
          .select()
          .from(auctionLots)
          .where(eq(auctionLots.id, auction.currentLotId))
          .limit(1);
        if (!lot || lot.status !== 'ACTIVE') throw new Error('LOT_NOT_ACTIVE');

        const [team] = await tx
          .select()
          .from(teams)
          .where(and(eq(teams.leagueId, leagueId), eq(teams.ownerId, userId)))
          .for('update')
          .limit(1);
        if (!team) throw new Error('TEAM_NOT_FOUND');
        rejectContext.teamId = team.id;

        if (auction.highestBidderTeamId === team.id) {
          throw new Error('ALREADY_HIGHEST_BIDDER');
        }

        const [alreadyOwned] = await tx
          .select()
          .from(teamPlayers)
          .where(
            and(
              eq(teamPlayers.leagueId, leagueId),
              eq(teamPlayers.playerId, auction.currentPlayerId)
            )
          )
          .limit(1);
        if (alreadyOwned) {
          throw new Error('PLAYER_ALREADY_OWNED_IN_LEAGUE');
        }

        if (team.squadCount >= league.maxSquadSize) {
          throw new Error('SQUAD_LIMIT_REACHED');
        }

        const [currentPlayer] = await tx
          .select()
          .from(players)
          .where(eq(players.id, auction.currentPlayerId))
          .limit(1);
        if (!currentPlayer) {
          throw new Error('PLAYER_NOT_FOUND');
        }

        const [settings] = await tx
          .select()
          .from(leagueSettings)
          .where(eq(leagueSettings.leagueId, leagueId))
          .limit(1);
        const maxOverseas = settings?.maxOverseas ?? 8;

        if (currentPlayer.isOverseas) {
          const teamRoster = await tx
            .select({
              isOverseas: players.isOverseas,
              ownershipStatus: teamPlayers.ownershipStatus,
            })
            .from(teamPlayers)
            .innerJoin(players, eq(teamPlayers.playerId, players.id))
            .where(eq(teamPlayers.teamId, team.id));

          const overseasCount = teamRoster.filter(
            (r) => r.ownershipStatus === 'OWNED' && r.isOverseas
          ).length;

          if (overseasCount >= maxOverseas) {
            throw new Error('OVERSEAS_LIMIT_REACHED');
          }
        }

        const minIncrement = computeMinimumBidIncrement(auction.currentBid ?? 0, {
          useTieredIncrements: auction.useTieredIncrements,
          bidIncrement: league.bidIncrement,
          tier1Increment: auction.tier1Increment,
          tier2Increment: auction.tier2Increment,
          tier3Increment: auction.tier3Increment,
        });

        const minimumRequired =
          auction.currentBid === null ? lot.basePrice : auction.currentBid + minIncrement;
        if (amount < minimumRequired) {
          throw new Error(`MIN_BID_REQUIRED:${minimumRequired}`);
        }

        if (team.remainingPurse < amount) {
          throw new Error('INSUFFICIENT_PURSE');
        }

        const timerSec = auction.timerSeconds || league.timerSeconds || 20;
        let nextDeadline = new Date(Date.now() + timerSec * 1000);
        let nextExtensionsUsed = auction.timerExtensionsUsed ?? 0;

        if (auction.maxTimerExtensions !== null && auction.maxTimerExtensions !== undefined) {
          if (auction.currentBid !== null) {
            if (nextExtensionsUsed < auction.maxTimerExtensions) {
              nextExtensionsUsed += 1;
              nextDeadline = new Date(Date.now() + timerSec * 1000);
            } else if (auction.lotDeadlineAt) {
              nextDeadline = auction.lotDeadlineAt;
            }
          }
        }

        await tx
          .update(auctions)
          .set({
            state: 'BIDDING',
            currentBid: amount,
            highestBidderTeamId: team.id,
            highestBidderUserId: userId,
            lotDeadlineAt: nextDeadline,
            timerExtensionsUsed: nextExtensionsUsed,
            updatedAt: new Date(),
          })
          .where(eq(auctions.id, auction.id));

        await tx.insert(auctionBids).values({
          auctionId: auction.id,
          leagueId,
          lotId: lot.id,
          playerId: auction.currentPlayerId,
          bidderUserId: userId,
          teamId: team.id,
          amount,
          status: 'ACCEPTED',
          idempotencyKey: idempotencyKey || null,
          isWinningBid: false,
        });

        await tx.insert(auctionEvents).values({
          auctionId: auction.id,
          lotId: lot.id,
          actorUserId: userId,
          teamId: team.id,
          eventType: 'BID_PLACED',
          amount,
          idempotencyKey: idempotencyKey || null,
          payload: {
            teamName: team.name,
            teamShortName: team.shortName,
            teamColor: team.primaryColor,
            playerName: currentPlayer.name,
          },
        });

        return {
          idempotentDuplicate: false,
          auctionId: auction.id,
          lotId: lot.id,
          team,
          amount,
          newDeadline: nextDeadline,
        };
      });

      if (txResult.idempotentDuplicate) {
        return { deduplicated: true, snapshot: await getAuctionSnapshot(leagueId) };
      }

      if (txResult.newDeadline) {
        scheduleAuctionDeadline(leagueId, txResult.newDeadline);
      }

      const snapshot = await getAuctionSnapshot(leagueId);
      const bidPayload = {
        leagueId,
        amount: txResult.amount,
        teamId: txResult.team?.id,
        teamName: txResult.team?.name,
        teamShortName: txResult.team?.shortName,
        lotDeadlineAt: txResult.newDeadline?.toISOString(),
        snapshot,
      };
      emit(leagueId, 'auction:bid', bidPayload);
      emit(leagueId, 'auction:bidAccepted', bidPayload);

      return { deduplicated: false, snapshot };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'BID_REJECTED';
      if (rejectContext.auctionId && rejectContext.lotId && rejectContext.playerId && rejectContext.teamId) {
        try {
          await db.insert(auctionBids).values({
            auctionId: rejectContext.auctionId,
            leagueId,
            lotId: rejectContext.lotId,
            playerId: rejectContext.playerId,
            bidderUserId: userId,
            teamId: rejectContext.teamId,
            amount,
            status: 'REJECTED',
            rejectionReason: reason,
            idempotencyKey: idempotencyKey || null,
            isWinningBid: false,
          });
        } catch {
          // Non-fatal bid ledger write failure
        }
      }
      throw err;
    }
  });
}

async function advanceOrCompleteAfterLotInTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  league: typeof leagues.$inferSelect,
  auction: typeof auctions.$inferSelect,
  soldResult: { sold: boolean; finalPrice: number; winningTeam: typeof teams.$inferSelect | null },
  previousPlayer: typeof players.$inferSelect | undefined
) {
  const [nextLot] = await tx
    .select()
    .from(auctionLots)
    .where(and(eq(auctionLots.auctionId, auction.id), eq(auctionLots.status, 'QUEUED')))
    .orderBy(asc(auctionLots.lotNumber))
    .limit(1);

  if (nextLot) {
    await tx
      .update(auctionLots)
      .set({ status: 'ACTIVE' })
      .where(eq(auctionLots.id, nextLot.id));

    const [nextPlayer] = await tx
      .select()
      .from(players)
      .where(eq(players.id, nextLot.playerId))
      .limit(1);

    const timerSec = auction.timerSeconds || league.timerSeconds || 20;
    const nextDeadline = new Date(Date.now() + timerSec * 1000);
    await tx
      .update(auctions)
      .set({
        state: 'LIVE',
        currentLotId: nextLot.id,
        currentPlayerId: nextLot.playerId,
        currentBid: null,
        highestBidderTeamId: null,
        highestBidderUserId: null,
        lotDeadlineAt: nextDeadline,
        lotOrder: nextLot.lotNumber,
        timerExtensionsUsed: 0,
        updatedAt: new Date(),
      })
      .where(eq(auctions.id, auction.id));

    await tx.insert(auctionEvents).values({
      auctionId: auction.id,
      lotId: nextLot.id,
      eventType: 'LOT_OPENED',
      amount: nextLot.basePrice,
      payload: {
        playerName: nextPlayer?.name,
        lotNumber: nextLot.lotNumber,
        roundNumber: nextLot.roundNumber,
      },
    });

    return {
      completed: false,
      soldResult,
      previousPlayer,
      nextDeadline,
    };
  }

  await tx
    .update(auctions)
    .set({
      state: 'COMPLETED',
      currentLotId: null,
      currentPlayerId: null,
      currentBid: null,
      highestBidderTeamId: null,
      highestBidderUserId: null,
      lotDeadlineAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(auctions.id, auction.id));

  await tx
    .update(leagues)
    .set({ status: 'COMPLETED', updatedAt: new Date() })
    .where(eq(leagues.id, league.id));

  await tx.insert(auctionEvents).values({
    auctionId: auction.id,
    eventType: 'AUCTION_COMPLETED',
    payload: { completedAt: new Date().toISOString() },
  });

  return {
    completed: true,
    soldResult,
    previousPlayer,
  };
}

export async function finalizeCurrentLot(leagueId: string, force = false) {
  return withAuctionLock(leagueId, async () => {
    const outcome = await db.transaction(async (tx) => {
      const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
      if (!league) return null;

      const [auction] = await tx
        .select()
        .from(auctions)
        .where(eq(auctions.leagueId, leagueId))
        .for('update')
        .limit(1);

      if (
        !auction ||
        (auction.state !== 'LIVE' &&
          auction.state !== 'BIDDING' &&
          auction.state !== 'AWAITING_FINALIZATION')
      ) {
        return null;
      }

      if (!force && auction.lotDeadlineAt && auction.lotDeadlineAt.getTime() > Date.now()) {
        return null;
      }

      if (!auction.currentLotId || !auction.currentPlayerId) {
        return null;
      }

      const [lot] = await tx
        .select()
        .from(auctionLots)
        .where(eq(auctionLots.id, auction.currentLotId))
        .for('update')
        .limit(1);

      if (!lot || lot.status !== 'ACTIVE') return null;

      await tx
        .update(auctions)
        .set({ state: 'AWAITING_FINALIZATION', updatedAt: new Date() })
        .where(eq(auctions.id, auction.id));

      const [player] = await tx
        .select()
        .from(players)
        .where(eq(players.id, auction.currentPlayerId))
        .limit(1);

      const [settings] = await tx
        .select()
        .from(leagueSettings)
        .where(eq(leagueSettings.leagueId, leagueId))
        .limit(1);
      const maxOverseas = settings?.maxOverseas ?? 8;

      let soldResult: {
        sold: boolean;
        finalPrice: number;
        winningTeam: typeof teams.$inferSelect | null;
      } = { sold: false, finalPrice: 0, winningTeam: null };

      if (auction.highestBidderTeamId && auction.currentBid !== null) {
        const [winningTeam] = await tx
          .select()
          .from(teams)
          .where(eq(teams.id, auction.highestBidderTeamId))
          .for('update')
          .limit(1);

        let overseasAllowed = true;
        if (player?.isOverseas && winningTeam) {
          const roster = await tx
            .select({
              isOverseas: players.isOverseas,
              ownershipStatus: teamPlayers.ownershipStatus,
            })
            .from(teamPlayers)
            .innerJoin(players, eq(teamPlayers.playerId, players.id))
            .where(eq(teamPlayers.teamId, winningTeam.id));
          const overseasCount = roster.filter(
            (r) => r.ownershipStatus === 'OWNED' && r.isOverseas
          ).length;
          if (overseasCount >= maxOverseas) {
            overseasAllowed = false;
          }
        }

        const [alreadyOwned] = await tx
          .select()
          .from(teamPlayers)
          .where(
            and(
              eq(teamPlayers.leagueId, leagueId),
              eq(teamPlayers.playerId, auction.currentPlayerId)
            )
          )
          .limit(1);

        if (
          winningTeam &&
          overseasAllowed &&
          !alreadyOwned &&
          winningTeam.remainingPurse >= auction.currentBid &&
          winningTeam.squadCount < league.maxSquadSize
        ) {
          await tx
            .update(teams)
            .set({
              remainingPurse: winningTeam.remainingPurse - auction.currentBid,
              squadCount: winningTeam.squadCount + 1,
            })
            .where(eq(teams.id, winningTeam.id));

          await tx.insert(teamPlayers).values({
            leagueId,
            teamId: winningTeam.id,
            playerId: auction.currentPlayerId,
            purchasePrice: auction.currentBid,
            ownershipStatus: 'OWNED',
            isPlayingXi: winningTeam.squadCount < 11,
            isSubstitute: winningTeam.squadCount >= 11,
          });

          await tx
            .update(auctionLots)
            .set({
              status: 'SOLD',
              soldPrice: auction.currentBid,
              winningTeamId: winningTeam.id,
              finalizedAt: new Date(),
            })
            .where(eq(auctionLots.id, lot.id));

          await tx
            .insert(auctionResults)
            .values({
              auctionId: auction.id,
              leagueId,
              lotId: lot.id,
              playerId: auction.currentPlayerId,
              winningTeamId: winningTeam.id,
              finalPrice: auction.currentBid,
              status: 'SOLD',
              finalizedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: auctionResults.lotId,
              set: {
                winningTeamId: winningTeam.id,
                finalPrice: auction.currentBid,
                status: 'SOLD',
                finalizedAt: new Date(),
              },
            });

          await tx
            .update(auctionBids)
            .set({ isWinningBid: true })
            .where(
              and(
                eq(auctionBids.lotId, lot.id),
                eq(auctionBids.teamId, winningTeam.id),
                eq(auctionBids.amount, auction.currentBid),
                eq(auctionBids.status, 'ACCEPTED')
              )
            );

          await tx.insert(auctionEvents).values({
            auctionId: auction.id,
            lotId: lot.id,
            teamId: winningTeam.id,
            actorUserId: auction.highestBidderUserId,
            eventType: 'LOT_SOLD',
            amount: auction.currentBid,
            payload: {
              playerName: player?.name,
              teamName: winningTeam.name,
              teamShortName: winningTeam.shortName,
            },
          });

          soldResult = {
            sold: true,
            finalPrice: auction.currentBid,
            winningTeam,
          };
        }
      }

      if (!soldResult.sold) {
        await tx
          .update(auctionLots)
          .set({
            status: 'UNSOLD',
            soldPrice: 0,
            winningTeamId: null,
            finalizedAt: new Date(),
          })
          .where(eq(auctionLots.id, lot.id));

        await tx
          .insert(auctionResults)
          .values({
            auctionId: auction.id,
            leagueId,
            lotId: lot.id,
            playerId: auction.currentPlayerId,
            winningTeamId: null,
            finalPrice: 0,
            status: 'UNSOLD',
            finalizedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: auctionResults.lotId,
            set: {
              winningTeamId: null,
              finalPrice: 0,
              status: 'UNSOLD',
              finalizedAt: new Date(),
            },
          });

        await tx.insert(auctionEvents).values({
          auctionId: auction.id,
          lotId: lot.id,
          eventType: 'LOT_UNSOLD',
          amount: 0,
          payload: { playerName: player?.name },
        });
      }

      return await advanceOrCompleteAfterLotInTx(tx, league, auction, soldResult, player);
    });

    if (!outcome) return null;

    const snapshot = await getAuctionSnapshot(leagueId);
    if (outcome.soldResult.sold) {
      emit(leagueId, 'auction:sold', {
        player: outcome.previousPlayer,
        team: outcome.soldResult.winningTeam,
        finalPrice: outcome.soldResult.finalPrice,
        snapshot,
      });
    } else {
      emit(leagueId, 'auction:unsold', {
        player: outcome.previousPlayer,
        snapshot,
      });
    }

    if (outcome.completed) {
      clearAuctionTimers(leagueId);
      emit(leagueId, 'auction:completed', snapshot);
    } else if ('nextDeadline' in outcome && outcome.nextDeadline) {
      scheduleAuctionDeadline(leagueId, outcome.nextDeadline);
      emit(leagueId, 'auction:player', snapshot);
    }

    return snapshot;
  });
}

export async function skipCurrentLot(leagueId: string, actorUserId: string) {
  return withAuctionLock(leagueId, async () => {
    const outcome = await db.transaction(async (tx) => {
      const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
      if (!league) throw new Error('LEAGUE_NOT_FOUND');

      const allowed = await isOwnerOrAdmin(tx as unknown as typeof db, actorUserId, league.ownerId);
      if (!allowed) throw new Error('ONLY_OWNER_CAN_CONTROL');

      const [auction] = await tx
        .select()
        .from(auctions)
        .where(eq(auctions.leagueId, leagueId))
        .for('update')
        .limit(1);
      if (!auction) throw new Error('AUCTION_NOT_FOUND');
      if (!auction.allowSkipPlayer) throw new Error('SKIP_PLAYER_DISABLED');
      if (auction.state !== 'LIVE' && auction.state !== 'BIDDING') {
        throw new Error('NO_ACTIVE_LOT');
      }
      if (auction.currentBid !== null) {
        throw new Error('CANNOT_SKIP_ACTIVE_BIDDING');
      }
      if (!auction.currentLotId || !auction.currentPlayerId) {
        throw new Error('NO_ACTIVE_LOT');
      }

      const [lot] = await tx
        .select()
        .from(auctionLots)
        .where(eq(auctionLots.id, auction.currentLotId))
        .for('update')
        .limit(1);
      if (!lot || lot.status !== 'ACTIVE') throw new Error('LOT_NOT_ACTIVE');

      const [player] = await tx
        .select()
        .from(players)
        .where(eq(players.id, auction.currentPlayerId))
        .limit(1);

      await tx
        .update(auctionLots)
        .set({
          status: 'UNSOLD',
          soldPrice: 0,
          winningTeamId: null,
          finalizedAt: new Date(),
        })
        .where(eq(auctionLots.id, lot.id));

      await tx
        .insert(auctionResults)
        .values({
          auctionId: auction.id,
          leagueId,
          lotId: lot.id,
          playerId: auction.currentPlayerId,
          winningTeamId: null,
          finalPrice: 0,
          status: 'UNSOLD',
          finalizedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: auctionResults.lotId,
          set: {
            winningTeamId: null,
            finalPrice: 0,
            status: 'UNSOLD',
            finalizedAt: new Date(),
          },
        });

      await tx.insert(auctionEvents).values({
        auctionId: auction.id,
        lotId: lot.id,
        actorUserId,
        eventType: 'LOT_SKIPPED',
        amount: 0,
        payload: { playerName: player?.name },
      });

      return await advanceOrCompleteAfterLotInTx(
        tx,
        league,
        auction,
        { sold: false, finalPrice: 0, winningTeam: null },
        player
      );
    });

    const snapshot = await getAuctionSnapshot(leagueId);
    emit(leagueId, 'auction:unsold', {
      player: outcome.previousPlayer,
      skipped: true,
      snapshot,
    });
    if (outcome.completed) {
      clearAuctionTimers(leagueId);
      emit(leagueId, 'auction:completed', snapshot);
    } else if ('nextDeadline' in outcome && outcome.nextDeadline) {
      scheduleAuctionDeadline(leagueId, outcome.nextDeadline);
      emit(leagueId, 'auction:player', snapshot);
    }
    return snapshot;
  });
}

export async function startUnsoldRound(leagueId: string, actorUserId: string) {
  return withAuctionLock(leagueId, async () => {
    const result = await db.transaction(async (tx) => {
      const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
      if (!league) throw new Error('LEAGUE_NOT_FOUND');

      const allowed = await isOwnerOrAdmin(tx as unknown as typeof db, actorUserId, league.ownerId);
      if (!allowed) throw new Error('ONLY_OWNER_CAN_CONTROL');

      const [auction] = await tx
        .select()
        .from(auctions)
        .where(eq(auctions.leagueId, leagueId))
        .for('update')
        .limit(1);
      if (!auction) throw new Error('AUCTION_NOT_FOUND');
      if (!auction.enableSecondRound) throw new Error('SECOND_ROUND_DISABLED');
      if (auction.state !== 'COMPLETED') throw new Error('FIRST_ROUND_NOT_COMPLETED');

      const unsoldLots = await tx
        .select()
        .from(auctionLots)
        .where(and(eq(auctionLots.auctionId, auction.id), eq(auctionLots.status, 'UNSOLD')))
        .orderBy(asc(auctionLots.lotNumber));

      const ownedRows = await tx
        .select({ playerId: teamPlayers.playerId })
        .from(teamPlayers)
        .where(eq(teamPlayers.leagueId, leagueId));
      const ownedSet = new Set(ownedRows.map((r) => r.playerId));

      const eligibleUnsold = unsoldLots.filter((l) => !ownedSet.has(l.playerId));
      if (eligibleUnsold.length === 0) {
        throw new Error('NO_UNSOLD_PLAYERS');
      }

      const nextRound = (auction.roundNumber ?? 1) + 1;
      for (let i = 0; i < eligibleUnsold.length; i++) {
        const l = eligibleUnsold[i];
        await tx
          .update(auctionLots)
          .set({
            status: i === 0 ? 'ACTIVE' : 'QUEUED',
            roundNumber: nextRound,
            lotNumber: i + 1,
            finalizedAt: null,
          })
          .where(eq(auctionLots.id, l.id));
      }

      const firstLot = eligibleUnsold[0];
      const [firstPlayer] = await tx
        .select()
        .from(players)
        .where(eq(players.id, firstLot.playerId))
        .limit(1);

      const timerSec = auction.timerSeconds || league.timerSeconds || 20;
      const deadline = new Date(Date.now() + timerSec * 1000);

      await tx
        .update(auctions)
        .set({
          state: 'LIVE',
          currentLotId: firstLot.id,
          currentPlayerId: firstLot.playerId,
          currentBid: null,
          highestBidderTeamId: null,
          highestBidderUserId: null,
          lotDeadlineAt: deadline,
          lotOrder: 1,
          roundNumber: nextRound,
          timerExtensionsUsed: 0,
          totalLots: eligibleUnsold.length,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(auctions.id, auction.id));

      await tx
        .update(leagues)
        .set({ status: 'AUCTION_IN_PROGRESS', updatedAt: new Date() })
        .where(eq(leagues.id, leagueId));

      await tx.insert(auctionEvents).values([
        {
          auctionId: auction.id,
          actorUserId,
          eventType: 'ROUND_STARTED',
          payload: { roundNumber: nextRound, totalLots: eligibleUnsold.length },
        },
        {
          auctionId: auction.id,
          lotId: firstLot.id,
          actorUserId,
          eventType: 'LOT_OPENED',
          amount: firstLot.basePrice,
          payload: { playerName: firstPlayer?.name, lotNumber: 1, roundNumber: nextRound },
        },
      ]);

      return { deadline };
    });

    scheduleAuctionDeadline(leagueId, result.deadline);
    const snapshot = await getAuctionSnapshot(leagueId);
    emit(leagueId, 'auction:started', snapshot);
    emit(leagueId, 'auction:player', snapshot);
    return snapshot;
  });
}

export async function endAuction(leagueId: string, actorUserId: string, force = false) {
  return withAuctionLock(leagueId, async () => {
    await db.transaction(async (tx) => {
      const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
      if (!league) throw new Error('LEAGUE_NOT_FOUND');

      const allowed = await isOwnerOrAdmin(tx as unknown as typeof db, actorUserId, league.ownerId);
      if (!allowed) throw new Error('ONLY_OWNER_CAN_CONTROL');

      const [auction] = await tx
        .select()
        .from(auctions)
        .where(eq(auctions.leagueId, leagueId))
        .for('update')
        .limit(1);
      if (!auction) throw new Error('AUCTION_NOT_FOUND');

      if (auction.state === 'COMPLETED' || auction.state === 'CANCELLED') {
        throw new Error('AUCTION_ALREADY_CLOSED');
      }
      if (!force && auction.currentBid !== null && (auction.state === 'LIVE' || auction.state === 'BIDDING')) {
        throw new Error('FINALIZE_ACTIVE_BID_FIRST');
      }

      if (auction.currentLotId) {
        await tx
          .update(auctionLots)
          .set({ status: 'SKIPPED', finalizedAt: new Date() })
          .where(eq(auctionLots.id, auction.currentLotId));
      }

      await tx
        .update(auctionLots)
        .set({ status: 'SKIPPED' })
        .where(and(eq(auctionLots.auctionId, auction.id), eq(auctionLots.status, 'QUEUED')));

      await tx
        .update(auctions)
        .set({
          state: 'COMPLETED',
          currentLotId: null,
          currentPlayerId: null,
          currentBid: null,
          highestBidderTeamId: null,
          highestBidderUserId: null,
          lotDeadlineAt: null,
          pausedRemainingMs: null,
          previousStateBeforePause: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(auctions.id, auction.id));

      await tx
        .update(leagues)
        .set({ status: 'COMPLETED', updatedAt: new Date() })
        .where(eq(leagues.id, leagueId));

      await tx.insert(auctionEvents).values({
        auctionId: auction.id,
        actorUserId,
        eventType: 'AUCTION_COMPLETED',
        payload: { endedEarlyByOwner: true, completedAt: new Date().toISOString() },
      });
    });

    clearAuctionTimers(leagueId);
    const snapshot = await getAuctionSnapshot(leagueId);
    emit(leagueId, 'auction:completed', snapshot);
    return snapshot;
  });
}

export async function cancelAuction(leagueId: string, actorUserId: string) {
  return withAuctionLock(leagueId, async () => {
    await db.transaction(async (tx) => {
      const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
      if (!league) throw new Error('LEAGUE_NOT_FOUND');

      const allowed = await isOwnerOrAdmin(tx as unknown as typeof db, actorUserId, league.ownerId);
      if (!allowed) throw new Error('ONLY_OWNER_CAN_CONTROL');

      const [auction] = await tx
        .select()
        .from(auctions)
        .where(eq(auctions.leagueId, leagueId))
        .for('update')
        .limit(1);
      if (!auction) throw new Error('AUCTION_NOT_FOUND');
      if (auction.state === 'COMPLETED' || auction.state === 'CANCELLED') {
        throw new Error('AUCTION_ALREADY_CLOSED');
      }

      await tx
        .update(auctions)
        .set({
          state: 'CANCELLED',
          currentLotId: null,
          currentPlayerId: null,
          currentBid: null,
          highestBidderTeamId: null,
          highestBidderUserId: null,
          lotDeadlineAt: null,
          pausedRemainingMs: null,
          updatedAt: new Date(),
        })
        .where(eq(auctions.id, auction.id));

      await tx
        .update(leagues)
        .set({ status: 'CANCELLED', inviteCodeActive: false, updatedAt: new Date() })
        .where(eq(leagues.id, leagueId));

      await tx.insert(auctionEvents).values({
        auctionId: auction.id,
        actorUserId,
        eventType: 'AUCTION_CANCELLED',
        payload: { cancelledAt: new Date().toISOString() },
      });
    });

    clearAuctionTimers(leagueId);
    const snapshot = await getAuctionSnapshot(leagueId);
    emit(leagueId, 'auction:cancelled', snapshot);
    return snapshot;
  });
}

export async function pauseAuction(leagueId: string, actorUserId: string) {
  return withAuctionLock(leagueId, async () => {
    await db.transaction(async (tx) => {
      const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
      if (!league) throw new Error('LEAGUE_NOT_FOUND');
      const allowed = await isOwnerOrAdmin(tx as unknown as typeof db, actorUserId, league.ownerId);
      if (!allowed) throw new Error('ONLY_OWNER_CAN_CONTROL');

      const [auction] = await tx
        .select()
        .from(auctions)
        .where(eq(auctions.leagueId, leagueId))
        .for('update')
        .limit(1);
      if (!auction) throw new Error('AUCTION_NOT_FOUND');
      if (auction.state !== 'LIVE' && auction.state !== 'BIDDING') {
        throw new Error('AUCTION_NOT_PAUSABLE');
      }

      const timerSec = auction.timerSeconds || league.timerSeconds || 20;
      const remainingMs = auction.lotDeadlineAt
        ? Math.max(250, auction.lotDeadlineAt.getTime() - Date.now())
        : timerSec * 1000;

      await tx
        .update(auctions)
        .set({
          previousStateBeforePause: auction.state,
          state: 'PAUSED',
          pausedRemainingMs: remainingMs,
          lotDeadlineAt: null,
          updatedAt: new Date(),
        })
        .where(eq(auctions.id, auction.id));

      await tx
        .update(leagues)
        .set({ status: 'PAUSED', updatedAt: new Date() })
        .where(eq(leagues.id, leagueId));

      await tx.insert(auctionEvents).values({
        auctionId: auction.id,
        lotId: auction.currentLotId,
        actorUserId,
        eventType: 'PAUSED',
        payload: { remainingMs },
      });
    });

    clearAuctionTimers(leagueId);
    const snapshot = await getAuctionSnapshot(leagueId);
    emit(leagueId, 'auction:paused', snapshot);
    return snapshot;
  });
}

export async function resumeAuction(leagueId: string, actorUserId: string) {
  return withAuctionLock(leagueId, async () => {
    await db.transaction(async (tx) => {
      const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
      if (!league) throw new Error('LEAGUE_NOT_FOUND');
      const allowed = await isOwnerOrAdmin(tx as unknown as typeof db, actorUserId, league.ownerId);
      if (!allowed) throw new Error('ONLY_OWNER_CAN_CONTROL');

      const [auction] = await tx
        .select()
        .from(auctions)
        .where(eq(auctions.leagueId, leagueId))
        .for('update')
        .limit(1);
      if (!auction) throw new Error('AUCTION_NOT_FOUND');
      if (auction.state !== 'PAUSED') throw new Error('AUCTION_NOT_PAUSED');

      const timerSec = auction.timerSeconds || league.timerSeconds || 20;
      const restoreMs = auction.pausedRemainingMs ?? timerSec * 1000;
      const newDeadline = new Date(Date.now() + restoreMs);

      await tx
        .update(auctions)
        .set({
          state: auction.previousStateBeforePause || 'LIVE',
          previousStateBeforePause: null,
          pausedRemainingMs: null,
          lotDeadlineAt: newDeadline,
          updatedAt: new Date(),
        })
        .where(eq(auctions.id, auction.id));

      await tx
        .update(leagues)
        .set({ status: 'AUCTION_IN_PROGRESS', updatedAt: new Date() })
        .where(eq(leagues.id, leagueId));

      await tx.insert(auctionEvents).values({
        auctionId: auction.id,
        lotId: auction.currentLotId,
        actorUserId,
        eventType: 'RESUMED',
        payload: { restoreMs },
      });
      return newDeadline;
    });

    const newDeadline = await db
      .select({ lotDeadlineAt: auctions.lotDeadlineAt })
      .from(auctions)
      .where(eq(auctions.leagueId, leagueId))
      .limit(1);

    if (newDeadline[0]?.lotDeadlineAt) {
      scheduleAuctionDeadline(leagueId, newDeadline[0].lotDeadlineAt);
    }

    const snapshot = await getAuctionSnapshot(leagueId);
    emit(leagueId, 'auction:resumed', snapshot);
    return snapshot;
  });
}

/**
 * Backend restart & failover recovery hook.
 * Scans persisted active auctions and restores countdown timers or immediately finalizes
 * lots whose deadlines elapsed while the server process was restarting.
 */
export async function recoverActiveAuctions() {
  const activeList = await db
    .select()
    .from(auctions)
    .where(inArray(auctions.state, ['LIVE', 'BIDDING', 'AWAITING_FINALIZATION']));

  let resumedCount = 0;
  let finalizedCount = 0;

  for (const auction of activeList) {
    try {
      const deadlineMs = auction.lotDeadlineAt ? auction.lotDeadlineAt.getTime() : 0;
      if (auction.state === 'AWAITING_FINALIZATION' || deadlineMs <= Date.now()) {
        await finalizeCurrentLot(auction.leagueId, true);
        finalizedCount += 1;
      } else if (auction.lotDeadlineAt) {
        scheduleAuctionDeadline(auction.leagueId, auction.lotDeadlineAt);
        resumedCount += 1;
      }
    } catch (error) {
      logEvent('ERROR', 'AuctionRecovery', 'Failed to recover active auction', {
        auctionId: auction.id,
        leagueId: auction.leagueId,
        error: String(error),
      });
    }
  }

  return { checked: activeList.length, resumedCount, finalizedCount };
}

// Active-only in-memory deadline timers (zero idle DB polling)
const activeLotTimers = new Map<
  string,
  { deadlineMs: number; finalizeTimer: NodeJS.Timeout; tickTimer: NodeJS.Timeout }
>();

export function clearAuctionTimers(leagueId: string) {
  const entry = activeLotTimers.get(leagueId);
  if (entry) {
    clearTimeout(entry.finalizeTimer);
    clearInterval(entry.tickTimer);
    activeLotTimers.delete(leagueId);
  }
}

export function scheduleAuctionDeadline(leagueId: string, deadline: Date) {
  clearAuctionTimers(leagueId);
  const deadlineMs = deadline.getTime();
  const delayMs = Math.max(50, deadlineMs - Date.now());

  const finalizeTimer = setTimeout(() => {
    clearAuctionTimers(leagueId);
    finalizeCurrentLot(leagueId, false).catch((err) => {
      logEvent('ERROR', 'AuctionTimer', 'Auto-finalize failed', { leagueId, error: String(err) });
    });
  }, delayMs);

  const tickTimer = setInterval(() => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      clearAuctionTimers(leagueId);
      return;
    }
    emit(leagueId, 'auction:timer', {
      leagueId,
      serverNow: Date.now(),
      lotDeadlineAt: deadline.toISOString(),
      remainingSeconds: Math.ceil(remainingMs / 1000),
    });
  }, 1000);

  activeLotTimers.set(leagueId, { deadlineMs, finalizeTimer, tickTimer });
}

export function stopAuctionTicker() {
  for (const leagueId of Array.from(activeLotTimers.keys())) {
    clearAuctionTimers(leagueId);
  }
}
