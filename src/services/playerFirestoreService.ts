import { doc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase.ts';
import type { CricketPlayer, SquadRoleCounts } from '../types/cricketverse.ts';

export async function syncAdminPlayerFirestore(player: CricketPlayer) {
  const path = `players/${player.id}`;
  try {
    const now = serverTimestamp();
    const batch = writeBatch(db);

    batch.set(doc(db, 'players', player.id), {
      playerId: player.id,
      playerCode: player.playerCode,
      name: player.name.slice(0, 60),
      imageUrl: player.imageUrl ? player.imageUrl.slice(0, 400000) : null,
      age: player.age,
      nationality: player.nationality.slice(0, 40),
      isOverseas: Boolean(player.isOverseas),
      nationalityCategory: player.isOverseas ? 'OVERSEAS' : 'DOMESTIC',
      role: player.role,
      battingStyle: player.battingStyle.slice(0, 50),
      bowlingStyle: player.bowlingStyle.slice(0, 50),
      basePrice: Math.round(player.basePrice),
      overallRating: Math.round(player.overallRating),
      experienceLevel: player.experienceLevel,
      availabilityStatus: player.availabilityStatus,
      isActive: Boolean(player.isActive),
      category: player.category,
      demandScore: Math.round(player.demandScore ?? 100),
      updatedAt: now,
    });

    batch.set(doc(db, 'player_attributes', player.id), {
      playerId: player.id,
      batting: Math.round(player.battingRating),
      battingTiming: Math.round(player.battingTiming),
      powerHitting: Math.round(player.powerHitting),
      bowling: Math.round(player.bowlingRating),
      bowlingAccuracy: Math.round(player.bowlingAccuracy),
      swing: Math.round(player.swing),
      spin: Math.round(player.spin),
      fielding: Math.round(player.fieldingRating),
      stamina: Math.round(player.stamina),
      experience: Math.round(player.experienceRating),
      overallRating: Math.round(player.overallRating),
      isActive: Boolean(player.isActive),
      updatedAt: now,
    });

    batch.set(doc(db, 'player_statistics', player.id), {
      playerId: player.id,
      seasonName: player.seasonStats?.seasonName || 'Premier Series 2026',
      matchesPlayed: player.seasonStats?.matchesPlayed ?? 10,
      runs: player.seasonStats?.runs ?? player.battingRating * 4,
      strikeRate: player.seasonStats?.strikeRate ?? 128,
      wickets: player.seasonStats?.wickets ?? 0,
      economyRate: player.seasonStats?.economyRate ?? 740,
      ratingOverall: Math.round(player.overallRating),
      isActive: Boolean(player.isActive),
      updatedAt: now,
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncPlayingXiFirestore(params: {
  leagueId: string;
  leagueOwnerId: string;
  teamId: string;
  ownerUid: string;
  captainPlayerId: string | null;
  viceCaptainPlayerId: string | null;
  wicketkeeperPlayerId: string | null;
  playingXiIds: string[];
  bowlingOrderIds: string[];
  substituteIds: string[];
  isValidForMatch: boolean;
  roleCounts?: SquadRoleCounts;
  isSquadComplete?: boolean;
}) {
  const teamDocId = `${params.leagueId}__${params.ownerUid}`;
  const path = `playing_xi/${teamDocId}`;
  try {
    const teamRef = doc(db, 'league_teams', teamDocId);
    const teamSnap = await getDoc(teamRef);
    if (!teamSnap.exists()) return;

    const now = serverTimestamp();
    const batch = writeBatch(db);

    batch.set(doc(db, 'playing_xi', teamDocId), {
      teamDocId,
      leagueId: params.leagueId,
      leagueOwnerId: params.leagueOwnerId,
      teamId: params.teamId,
      ownerId: params.ownerUid,
      captainPlayerId: params.captainPlayerId,
      viceCaptainPlayerId: params.viceCaptainPlayerId,
      wicketkeeperPlayerId: params.wicketkeeperPlayerId,
      playingXiIds: params.playingXiIds.slice(0, 11),
      bowlingOrderIds: params.bowlingOrderIds.slice(0, 11),
      substituteIds: params.substituteIds.slice(0, 25),
      isValidForMatch: Boolean(params.isValidForMatch),
      updatedAt: now,
    });

    if (params.roleCounts) {
      batch.update(teamRef, {
        playersCount: params.roleCounts.total,
        batsmenCount: params.roleCounts.batsmen,
        bowlersCount: params.roleCounts.bowlers,
        allRoundersCount: params.roleCounts.allRounders,
        wicketkeepersCount: params.roleCounts.wicketkeepers,
        overseasCount: params.roleCounts.overseas,
        isSquadComplete: Boolean(params.isSquadComplete),
        squadStatus: params.isSquadComplete ? 'MEETS_MIN' : 'UNFILLED',
        updatedAt: now,
      });
    }

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncTeamPlayerOwnershipFirestore(params: {
  leagueId: string;
  leagueOwnerId: string;
  teamId: string;
  ownerUid: string;
  playerId: string;
  purchasePrice: number;
  ownershipStatus?: 'OWNED' | 'RELEASED' | 'LOANED';
}) {
  const ownershipId = `${params.leagueId}__${params.playerId}`;
  const path = `team_players/${ownershipId}`;
  try {
    const teamDocId = `${params.leagueId}__${params.ownerUid}`;
    const teamSnap = await getDoc(doc(db, 'league_teams', teamDocId));
    if (!teamSnap.exists()) return;

    const now = serverTimestamp();
    const batch = writeBatch(db);
    batch.set(doc(db, 'team_players', ownershipId), {
      ownershipId,
      leagueId: params.leagueId,
      leagueOwnerId: params.leagueOwnerId,
      teamId: params.teamId,
      ownerId: params.ownerUid,
      playerId: params.playerId,
      purchasePrice: Math.round(params.purchasePrice),
      purchaseDate: now,
      ownershipStatus: params.ownershipStatus ?? 'OWNED',
      updatedAt: now,
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}
