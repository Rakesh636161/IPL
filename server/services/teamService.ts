import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/index.ts';
import {
  auditLogs,
  leagues,
  leagueSettings,
  players,
  teamPlayers,
  teams,
  userProfiles,
} from '../../src/db/schema.ts';
import {
  DEFAULT_SQUAD_RULES,
  SquadRulesConfig,
  validatePlayingXiSelection,
  validateSquadComposition,
} from '../../src/lib/cricketEngine.ts';

function buildRulesFromLeague(
  league: typeof leagues.$inferSelect | undefined,
  settings: typeof leagueSettings.$inferSelect | undefined
): SquadRulesConfig {
  return {
    minSquadSize: league?.minSquadSize ?? DEFAULT_SQUAD_RULES.minSquadSize,
    maxSquadSize: league?.maxSquadSize ?? DEFAULT_SQUAD_RULES.maxSquadSize,
    maxOverseas: settings?.maxOverseas ?? DEFAULT_SQUAD_RULES.maxOverseas,
    minWicketkeepers: settings?.minWicketkeepers ?? DEFAULT_SQUAD_RULES.minWicketkeepers,
    minBatsmen: settings?.minBatsmen ?? DEFAULT_SQUAD_RULES.minBatsmen,
    minBowlers: settings?.minBowlers ?? DEFAULT_SQUAD_RULES.minBowlers,
    minAllRounders: settings?.minAllRounders ?? DEFAULT_SQUAD_RULES.minAllRounders,
  };
}

export async function getTeamWithRoster(teamId: string) {
  try {
    const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
    if (!team) return null;

    const [ownerProfile] = await db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, team.ownerId))
      .limit(1);

    const [league] = await db.select().from(leagues).where(eq(leagues.id, team.leagueId)).limit(1);
    const [settings] = await db
      .select()
      .from(leagueSettings)
      .where(eq(leagueSettings.leagueId, team.leagueId))
      .limit(1);

    const rosterRows = await db
      .select({
        teamPlayerId: teamPlayers.id,
        leagueId: teamPlayers.leagueId,
        teamId: teamPlayers.teamId,
        playerId: teamPlayers.playerId,
        purchasePrice: teamPlayers.purchasePrice,
        ownershipStatus: teamPlayers.ownershipStatus,
        isPlayingXi: teamPlayers.isPlayingXi,
        isSubstitute: teamPlayers.isSubstitute,
        battingOrder: teamPlayers.battingOrder,
        bowlingOrder: teamPlayers.bowlingOrder,
        acquiredAt: teamPlayers.acquiredAt,
        player: players,
      })
      .from(teamPlayers)
      .innerJoin(players, eq(teamPlayers.playerId, players.id))
      .where(eq(teamPlayers.teamId, teamId))
      .orderBy(asc(teamPlayers.battingOrder), asc(teamPlayers.acquiredAt));

    const rules = buildRulesFromLeague(league, settings);
    const squadValidation = validateSquadComposition(
      rosterRows.map((r) => ({
        role: r.player.role,
        isOverseas: r.player.isOverseas,
        ownershipStatus: r.ownershipStatus,
      })),
      rules
    );

    const xiIds = rosterRows
      .filter((r) => r.isPlayingXi)
      .sort((a, b) => (a.battingOrder ?? 99) - (b.battingOrder ?? 99))
      .map((r) => r.player.id);
    const subIds = rosterRows
      .filter((r) => !r.isPlayingXi)
      .map((r) => r.player.id);
    const bowlIds = rosterRows
      .filter((r) => r.isPlayingXi && r.bowlingOrder !== null)
      .sort((a, b) => (a.bowlingOrder ?? 99) - (b.bowlingOrder ?? 99))
      .map((r) => r.player.id);

    const playingXiValidation = validatePlayingXiSelection({
      ownedPlayerIds: rosterRows.map((r) => r.player.id),
      playingXiIds: xiIds,
      substituteIds: subIds,
      captainPlayerId: team.captainPlayerId,
      viceCaptainPlayerId: team.viceCaptainPlayerId,
      wicketkeeperPlayerId: team.wicketkeeperPlayerId,
      bowlingOrderIds: bowlIds,
    });

    return {
      team: {
        ...team,
        ownerName: ownerProfile?.displayName ?? 'Franchise Owner',
        ownerPlayerId: ownerProfile?.uniquePlayerId ?? null,
      },
      league: league ?? null,
      settings: settings ?? null,
      rules,
      roleCounts: squadValidation.counts,
      squadValidation,
      playingXiValidation,
      roster: rosterRows,
    };
  } catch (error) {
    throw new Error('Failed to load team roster.', { cause: error });
  }
}

export async function getUserTeams(userId: string) {
  try {
    const userTeams = await db.select().from(teams).where(eq(teams.ownerId, userId));
    if (userTeams.length === 0) return [];

    const leagueIds = Array.from(new Set(userTeams.map((t) => t.leagueId)));
    const leagueList = await db.select().from(leagues).where(inArray(leagues.id, leagueIds));
    const leagueMap = new Map(leagueList.map((l) => [l.id, l]));

    const [ownerProfile] = await db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);

    return userTeams.map((t) => {
      const l = leagueMap.get(t.leagueId);
      return {
        ...t,
        ownerName: ownerProfile?.displayName ?? 'Franchise Owner',
        ownerPlayerId: ownerProfile?.uniquePlayerId ?? null,
        leagueName: l?.name ?? 'League',
        leagueStatus: l?.status ?? 'OPEN',
        minSquadSize: l?.minSquadSize ?? DEFAULT_SQUAD_RULES.minSquadSize,
        maxSquadSize: l?.maxSquadSize ?? DEFAULT_SQUAD_RULES.maxSquadSize,
      };
    });
  } catch (error) {
    throw new Error('Failed to load user teams.', { cause: error });
  }
}

/**
 * Trusted backend ownership assignment for a player within a specific league.
 * Prevents duplicate ownership in the same league while allowing the same player across different leagues.
 * Does NOT force final squad minimum rules before the auction finishes.
 */
export async function assignPlayerToTeamInLeague(params: {
  actorUserId: string;
  leagueId: string;
  teamId: string;
  playerId: string;
  purchasePrice: number;
  enforceActorOwnership?: boolean;
}) {
  const { actorUserId, leagueId, teamId, playerId, purchasePrice, enforceActorOwnership = true } = params;
  if (!Number.isInteger(purchasePrice) || purchasePrice <= 0) {
    throw new Error('INVALID_PURCHASE_PRICE');
  }

  return await db.transaction(async (tx) => {
    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for('update')
      .limit(1);
    if (!league) throw new Error('LEAGUE_NOT_FOUND');

    const [team] = await tx
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.leagueId, leagueId)))
      .for('update')
      .limit(1);
    if (!team) throw new Error('TEAM_NOT_FOUND');
    if (enforceActorOwnership && team.ownerId !== actorUserId && league.ownerId !== actorUserId) {
      throw new Error('FORBIDDEN');
    }

    const [player] = await tx.select().from(players).where(eq(players.id, playerId)).limit(1);
    if (!player) throw new Error('PLAYER_NOT_FOUND');
    if (!player.isActive || player.availabilityStatus === 'INACTIVE') {
      throw new Error('PLAYER_UNAVAILABLE');
    }

    const [alreadyOwned] = await tx
      .select()
      .from(teamPlayers)
      .where(and(eq(teamPlayers.leagueId, leagueId), eq(teamPlayers.playerId, playerId)))
      .limit(1);
    if (alreadyOwned) {
      throw new Error('PLAYER_ALREADY_OWNED_IN_LEAGUE');
    }

    if (team.squadCount >= league.maxSquadSize) {
      throw new Error('SQUAD_LIMIT_REACHED');
    }

    if (team.remainingPurse < purchasePrice) {
      throw new Error('INSUFFICIENT_PURSE');
    }

    const [record] = await tx
      .insert(teamPlayers)
      .values({
        leagueId,
        teamId,
        playerId,
        purchasePrice,
        ownershipStatus: 'OWNED',
        isPlayingXi: false,
        isSubstitute: true,
      })
      .returning();

    const [updatedTeam] = await tx
      .update(teams)
      .set({
        remainingPurse: team.remainingPurse - purchasePrice,
        squadCount: team.squadCount + 1,
        isSquadComplete: false,
      })
      .where(eq(teams.id, teamId))
      .returning();

    await tx.insert(auditLogs).values({
      actorUserId,
      action: 'TEAM_PLAYER_ASSIGNED',
      resourceType: 'TEAM_PLAYER',
      resourceId: record.id,
      details: { leagueId, teamId, playerId, purchasePrice },
    });

    return { ownership: record, team: updatedTeam };
  });
}

export async function markTeamSquadComplete(userId: string, teamId: string) {
  const details = await getTeamWithRoster(teamId);
  if (!details) throw new Error('TEAM_NOT_FOUND');
  if (details.team.ownerId !== userId && details.league?.ownerId !== userId) {
    throw new Error('FORBIDDEN');
  }

  if (!details.squadValidation.isValid) {
    const failedMessages = details.squadValidation.checks
      .filter((c) => !c.passed)
      .map((c) => c.message)
      .join(' ');
    const err = new Error(`SQUAD_RULES_NOT_MET: ${failedMessages}`);
    throw err;
  }

  await db.update(teams).set({ isSquadComplete: true }).where(eq(teams.id, teamId));
  return await getTeamWithRoster(teamId);
}

export interface UpdateTeamLineupInput {
  teamName?: string;
  shortName?: string;
  primaryColor?: string;
  captainPlayerId?: string | null;
  viceCaptainPlayerId?: string | null;
  wicketkeeperPlayerId?: string | null;
  playingXiIds: string[]; // playerIds in batting order
  bowlingOrderIds: string[]; // playerIds in bowling order
  substituteIds?: string[];
  requireFullXi?: boolean;
}

export async function updateTeamLineup(userId: string, teamId: string, input: UpdateTeamLineupInput) {
  try {
    await db.transaction(async (tx) => {
      const [team] = await tx
        .select()
        .from(teams)
        .where(and(eq(teams.id, teamId), eq(teams.ownerId, userId)))
        .limit(1);

      if (!team) {
        throw new Error('TEAM_NOT_FOUND_OR_FORBIDDEN');
      }

      const roster = await tx
        .select()
        .from(teamPlayers)
        .where(eq(teamPlayers.teamId, teamId));

      const ownedPlayerIds = new Set(roster.map((r) => r.playerId));

      // Reject duplicates explicitly instead of silently swallowing invalid duplicate submissions
      const uniqueXi = Array.from(new Set(input.playingXiIds));
      if (uniqueXi.length !== input.playingXiIds.length) {
        throw new Error('DUPLICATE_PLAYER_IN_XI');
      }
      if (uniqueXi.length > 11) {
        throw new Error('PLAYING_XI_LIMIT_EXCEEDED');
      }

      for (const pid of uniqueXi) {
        if (!ownedPlayerIds.has(pid)) {
          throw new Error('PLAYER_NOT_IN_SQUAD');
        }
      }

      const uniqueBowlers = Array.from(new Set(input.bowlingOrderIds));
      if (uniqueBowlers.length !== input.bowlingOrderIds.length) {
        throw new Error('DUPLICATE_BOWLER');
      }
      const xiSet = new Set(uniqueXi);
      for (const bid of uniqueBowlers) {
        if (!ownedPlayerIds.has(bid)) {
          throw new Error('PLAYER_NOT_IN_SQUAD');
        }
        if (uniqueXi.length > 0 && !xiSet.has(bid)) {
          throw new Error('BOWLER_NOT_IN_XI');
        }
      }

      if (input.substituteIds) {
        const uniqueSubs = Array.from(new Set(input.substituteIds));
        if (uniqueSubs.length !== input.substituteIds.length) {
          throw new Error('DUPLICATE_SUBSTITUTE');
        }
        for (const sid of uniqueSubs) {
          if (!ownedPlayerIds.has(sid)) {
            throw new Error('PLAYER_NOT_IN_SQUAD');
          }
          if (xiSet.has(sid)) {
            throw new Error('PLAYER_IN_BOTH_XI_AND_SUBS');
          }
        }
      }

      if (input.captainPlayerId && !ownedPlayerIds.has(input.captainPlayerId)) {
        throw new Error('CAPTAIN_NOT_IN_SQUAD');
      }
      if (input.viceCaptainPlayerId && !ownedPlayerIds.has(input.viceCaptainPlayerId)) {
        throw new Error('VICE_CAPTAIN_NOT_IN_SQUAD');
      }
      if (
        input.captainPlayerId &&
        input.viceCaptainPlayerId &&
        input.captainPlayerId === input.viceCaptainPlayerId
      ) {
        throw new Error('VICE_CAPTAIN_SAME_AS_CAPTAIN');
      }
      if (input.wicketkeeperPlayerId && !ownedPlayerIds.has(input.wicketkeeperPlayerId)) {
        throw new Error('KEEPER_NOT_IN_SQUAD');
      }

      if (input.requireFullXi) {
        const xiCheck = validatePlayingXiSelection({
          ownedPlayerIds: Array.from(ownedPlayerIds),
          playingXiIds: uniqueXi,
          substituteIds: input.substituteIds,
          captainPlayerId: input.captainPlayerId,
          viceCaptainPlayerId: input.viceCaptainPlayerId,
          wicketkeeperPlayerId: input.wicketkeeperPlayerId,
          bowlingOrderIds: uniqueBowlers,
        });
        if (!xiCheck.isValid) {
          throw new Error(`PLAYING_XI_INVALID: ${xiCheck.errors.join(' ')}`);
        }
      }

      await tx
        .update(teams)
        .set({
          name: input.teamName?.trim() || team.name,
          shortName: input.shortName?.trim().toUpperCase().slice(0, 4) || team.shortName,
          primaryColor: input.primaryColor || team.primaryColor,
          captainPlayerId: input.captainPlayerId !== undefined ? input.captainPlayerId : team.captainPlayerId,
          viceCaptainPlayerId:
            input.viceCaptainPlayerId !== undefined ? input.viceCaptainPlayerId : team.viceCaptainPlayerId,
          wicketkeeperPlayerId:
            input.wicketkeeperPlayerId !== undefined ? input.wicketkeeperPlayerId : team.wicketkeeperPlayerId,
        })
        .where(eq(teams.id, teamId));

      // Reset all squad flags first (remaining squad becomes substitutes)
      await tx
        .update(teamPlayers)
        .set({ isPlayingXi: false, isSubstitute: true, battingOrder: null, bowlingOrder: null })
        .where(eq(teamPlayers.teamId, teamId));

      // Update Playing XI, batting order & bowling order
      for (let i = 0; i < uniqueXi.length; i++) {
        const pid = uniqueXi[i];
        const bowlIdx = uniqueBowlers.indexOf(pid);
        await tx
          .update(teamPlayers)
          .set({
            isPlayingXi: true,
            isSubstitute: false,
            battingOrder: i + 1,
            bowlingOrder: bowlIdx >= 0 ? bowlIdx + 1 : null,
          })
          .where(and(eq(teamPlayers.teamId, teamId), eq(teamPlayers.playerId, pid)));
      }
    });

    return await getTeamWithRoster(teamId);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('PLAYING_XI_INVALID') ||
        [
          'TEAM_NOT_FOUND_OR_FORBIDDEN',
          'PLAYING_XI_LIMIT_EXCEEDED',
          'DUPLICATE_PLAYER_IN_XI',
          'DUPLICATE_BOWLER',
          'DUPLICATE_SUBSTITUTE',
          'PLAYER_IN_BOTH_XI_AND_SUBS',
          'BOWLER_NOT_IN_XI',
          'PLAYER_NOT_IN_SQUAD',
          'CAPTAIN_NOT_IN_SQUAD',
          'VICE_CAPTAIN_NOT_IN_SQUAD',
          'VICE_CAPTAIN_SAME_AS_CAPTAIN',
          'KEEPER_NOT_IN_SQUAD',
        ].includes(error.message))
    ) {
      throw error;
    }
    throw new Error('Failed to update team lineup.', { cause: error });
  }
}
