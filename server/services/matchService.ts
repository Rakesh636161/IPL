import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../src/db/index.ts';
import {
  fixtures,
  matches,
  matchEvents,
  matchInnings,
  players,
  standings,
  teamPlayers,
  teams,
} from '../../src/db/schema.ts';

import { getTeamWithRoster } from './teamService.ts';

async function getTeamStrength(
  teamId: string,
  requireValidXi = false
): Promise<{ batting: number; bowling: number; name: string }> {
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (!team) throw new Error('TEAM_NOT_FOUND');

  if (requireValidXi) {
    const details = await getTeamWithRoster(teamId);
    if (!details || !details.playingXiValidation.isValid) {
      const reasons = details?.playingXiValidation.errors.join(' ') || 'Playing XI is incomplete.';
      throw new Error(`PLAYING_XI_INVALID: ${team.name}: ${reasons}`);
    }
  } else {
    const details = await getTeamWithRoster(teamId);
    if (details && details.roster.length >= 11 && !details.playingXiValidation.isValid) {
      const reasons = details.playingXiValidation.errors.join(' ');
      throw new Error(`PLAYING_XI_INVALID: ${team.name}: ${reasons}`);
    }
  }

  const squad = await db
    .select({
      battingRating: players.battingRating,
      bowlingRating: players.bowlingRating,
      isPlayingXi: teamPlayers.isPlayingXi,
    })
    .from(teamPlayers)
    .innerJoin(players, eq(teamPlayers.playerId, players.id))
    .where(eq(teamPlayers.teamId, teamId));

  if (squad.length === 0) {
    return { batting: 68, bowling: 68, name: team.name };
  }

  const xi = squad.filter((s) => s.isPlayingXi);
  const active = xi.length > 0 ? xi : squad.slice(0, 11);
  const avgBat = active.reduce((acc, s) => acc + s.battingRating, 0) / active.length;
  const avgBowl = active.reduce((acc, s) => acc + s.bowlingRating, 0) / active.length;
  return { batting: avgBat, bowling: avgBowl, name: team.name };
}

export async function validateMatchPlayingXi(teamId: string) {
  const details = await getTeamWithRoster(teamId);
  if (!details) throw new Error('TEAM_NOT_FOUND');
  return details.playingXiValidation;
}

export async function simulateQuickMatch(
  homeTeamId: string,
  awayTeamId: string,
  mode: 'AI' | '1V1' | 'TOURNAMENT',
  leagueId?: string,
  options?: { requireValidXi?: boolean }
) {
  try {
    const home = await getTeamStrength(homeTeamId, options?.requireValidXi);
    const away = await getTeamStrength(awayTeamId, options?.requireValidXi);

    const simulateInnings = (batSkill: number, bowlSkill: number) => {
      const edge = (batSkill - bowlSkill) * 0.45;
      const baseRuns = Math.max(105, Math.min(242, Math.round(162 + edge + (Math.random() * 44 - 22))));
      const wickets = Math.min(10, Math.max(2, Math.round(6 - edge * 0.08 + (Math.random() * 4 - 2))));
      return { runs: baseRuns, wickets, overs: 20, balls: 0 };
    };

    const inn1 = simulateInnings(home.batting, away.bowling);
    const inn2 = simulateInnings(away.batting, home.bowling);

    const winnerTeamId =
      inn1.runs > inn2.runs ? homeTeamId : inn2.runs > inn1.runs ? awayTeamId : null;
    const summaryText =
      inn1.runs > inn2.runs
        ? `${home.name} won by ${inn1.runs - inn2.runs} runs`
        : inn2.runs > inn1.runs
        ? `${away.name} won by ${10 - inn2.wickets} wickets`
        : 'Match tied after 20 overs';

    return await db.transaction(async (tx) => {
      let fixtureId: string | null = null;
      if (leagueId && mode === 'TOURNAMENT') {
        const [fixture] = await tx
          .insert(fixtures)
          .values({
            leagueId,
            homeTeamId,
            awayTeamId,
            roundNumber: 1,
            status: 'COMPLETED',
          })
          .returning();
        fixtureId = fixture.id;
      }

      const [match] = await tx
        .insert(matches)
        .values({
          fixtureId,
          leagueId: leagueId || null,
          homeTeamId,
          awayTeamId,
          mode,
          winnerTeamId,
          summaryText,
          status: 'COMPLETED',
        })
        .returning();

      const [firstInnings] = await tx
        .insert(matchInnings)
        .values({
          matchId: match.id,
          battingTeamId: homeTeamId,
          inningsNumber: 1,
          ...inn1,
        })
        .returning();

      const [secondInnings] = await tx
        .insert(matchInnings)
        .values({
          matchId: match.id,
          battingTeamId: awayTeamId,
          inningsNumber: 2,
          ...inn2,
        })
        .returning();

      await tx.insert(matchEvents).values([
        {
          matchId: match.id,
          inningsId: firstInnings.id,
          overNumber: 20,
          ballNumber: 6,
          runsScored: inn1.runs,
          isWicket: false,
          commentary: `${home.name} closed innings 1 at ${inn1.runs}/${inn1.wickets} (20.0 ov).`,
        },
        {
          matchId: match.id,
          inningsId: secondInnings.id,
          overNumber: 20,
          ballNumber: 6,
          runsScored: inn2.runs,
          isWicket: false,
          commentary: `${away.name} finished at ${inn2.runs}/${inn2.wickets}. ${summaryText}.`,
        },
      ]);

      if (leagueId) {
        for (const tid of [homeTeamId, awayTeamId]) {
          const isWin = winnerTeamId === tid;
          const isTie = winnerTeamId === null;
          const [existing] = await tx
            .select()
            .from(standings)
            .where(and(eq(standings.leagueId, leagueId), eq(standings.teamId, tid)))
            .limit(1);

          const pts = isWin ? 2 : isTie ? 1 : 0;
          if (!existing) {
            await tx.insert(standings).values({
              leagueId,
              teamId: tid,
              played: 1,
              won: isWin ? 1 : 0,
              lost: !isWin && !isTie ? 1 : 0,
              tied: isTie ? 1 : 0,
              points: pts,
              netRunRateScaled: tid === homeTeamId ? (inn1.runs - inn2.runs) * 5 : (inn2.runs - inn1.runs) * 5,
            });
          } else {
            await tx
              .update(standings)
              .set({
                played: existing.played + 1,
                won: existing.won + (isWin ? 1 : 0),
                lost: existing.lost + (!isWin && !isTie ? 1 : 0),
                tied: existing.tied + (isTie ? 1 : 0),
                points: existing.points + pts,
              })
              .where(eq(standings.id, existing.id));
          }
        }
      }

      return {
        match,
        innings: [firstInnings, secondInnings],
      };
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('PLAYING_XI_INVALID') || error.message === 'TEAM_NOT_FOUND')
    ) {
      throw error;
    }
    throw new Error('Failed to simulate match.', { cause: error });
  }
}

export async function getLeagueStandingsAndMatches(leagueId: string) {
  try {
    const table = await db
      .select({
        standing: standings,
        teamName: teams.name,
        shortName: teams.shortName,
        primaryColor: teams.primaryColor,
      })
      .from(standings)
      .innerJoin(teams, eq(standings.teamId, teams.id))
      .where(eq(standings.leagueId, leagueId))
      .orderBy(desc(standings.points), desc(standings.netRunRateScaled));

    const recentMatches = await db
      .select()
      .from(matches)
      .where(eq(matches.leagueId, leagueId))
      .orderBy(desc(matches.createdAt))
      .limit(15);

    return { standings: table, matches: recentMatches };
  } catch (error) {
    throw new Error('Failed to load tournament standings.', { cause: error });
  }
}
