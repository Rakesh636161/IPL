import { desc, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../src/db/index.ts';
import {
  auctions,
  leagueMembers,
  leagues,
  matches,
  teamPlayers,
  teams,
  users,
} from '../../src/db/schema.ts';

export interface AuctionParticipationRecord {
  leagueId: string;
  leagueName: string;
  teamName: string;
  teamShortName: string;
  auctionState: string;
  playersWon: number;
  totalSpent: number;
  remainingPurse: number;
  participatedAt: string;
}

export interface UserStatisticsPayload {
  uid: string;
  registrationDate: string;
  totalMatches: number;
  totalWins: number;
  totalTournaments: number;
  auctionsParticipated: number;
  playersAcquired: number;
  totalSpent: number;
  auctionHistory: AuctionParticipationRecord[];
}

export async function getUserStatistics(userId: string, uid: string): Promise<UserStatisticsPayload> {
  const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const registrationDate = (userRow?.createdAt ?? new Date()).toISOString();

  const userTeams = await db
    .select()
    .from(teams)
    .where(eq(teams.ownerId, userId));

  const teamIds = userTeams.map((t) => t.id);
  const teamIdSet = new Set(teamIds);

  let totalMatches = 0;
  let totalWins = 0;

  if (teamIds.length > 0) {
    const teamMatches = await db
      .select()
      .from(matches)
      .where(or(inArray(matches.homeTeamId, teamIds), inArray(matches.awayTeamId, teamIds)));

    const completedMatches = teamMatches.filter((m) => m.status === 'COMPLETED');
    totalMatches = completedMatches.length;
    totalWins = completedMatches.filter((m) => m.winnerTeamId && teamIdSet.has(m.winnerTeamId)).length;
  }

  const memberships = await db
    .select({
      leagueId: leagues.id,
      leagueName: leagues.name,
      joinedAt: leagueMembers.joinedAt,
    })
    .from(leagueMembers)
    .innerJoin(leagues, eq(leagueMembers.leagueId, leagues.id))
    .where(eq(leagueMembers.userId, userId))
    .orderBy(desc(leagueMembers.joinedAt));

  const totalTournaments = memberships.length;
  const leagueIds = memberships.map((m) => m.leagueId);

  const auctionRows =
    leagueIds.length > 0
      ? await db.select().from(auctions).where(inArray(auctions.leagueId, leagueIds))
      : [];

  const auctionByLeague = new Map(auctionRows.map((a) => [a.leagueId, a]));

  const acquiredPlayers =
    teamIds.length > 0
      ? await db.select().from(teamPlayers).where(inArray(teamPlayers.teamId, teamIds))
      : [];

  const playersAcquired = acquiredPlayers.length;
  const totalSpent = acquiredPlayers.reduce((sum, p) => sum + p.purchasePrice, 0);

  const spentByTeam = new Map<string, { count: number; spent: number }>();
  for (const tp of acquiredPlayers) {
    const prev = spentByTeam.get(tp.teamId) || { count: 0, spent: 0 };
    spentByTeam.set(tp.teamId, {
      count: prev.count + 1,
      spent: prev.spent + tp.purchasePrice,
    });
  }

  const auctionHistory: AuctionParticipationRecord[] = [];
  for (const m of memberships) {
    const auction = auctionByLeague.get(m.leagueId);
    const team = userTeams.find((t) => t.leagueId === m.leagueId);
    if (!auction || !team || auction.state === 'WAITING') continue;
    const stats = spentByTeam.get(team.id) || { count: team.squadCount, spent: team.totalPurse - team.remainingPurse };
    auctionHistory.push({
      leagueId: m.leagueId,
      leagueName: m.leagueName,
      teamName: team.name,
      teamShortName: team.shortName,
      auctionState: auction.state,
      playersWon: stats.count,
      totalSpent: stats.spent,
      remainingPurse: team.remainingPurse,
      participatedAt: (auction.startedAt ?? m.joinedAt).toISOString(),
    });
  }

  const boundedHistory = auctionHistory.slice(0, 25);

  const payload: UserStatisticsPayload = {
    uid,
    registrationDate,
    totalMatches,
    totalWins,
    totalTournaments,
    auctionsParticipated: auctionHistory.length,
    playersAcquired,
    totalSpent,
    auctionHistory: boundedHistory,
  };

  return payload;
}
