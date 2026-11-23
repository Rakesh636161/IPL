import crypto from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../src/db/index.ts';
import {
  auctions,
  auditLogs,
  leagueActivity,
  leagueInvitations,
  leagueMembers,
  leagues,
  leagueSettings,
  notifications,
  teams,
  userProfiles,
  users,
} from '../../src/db/schema.ts';
import { logEvent } from '../lib/logger.ts';

const TEAM_PALETTE = [
  '#D4AF37', '#10B981', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6',
  '#06B6D4', '#EC4899', '#84CC16', '#F97316', '#6366F1', '#14B8A6',
];

const PRE_AUCTION_STATUSES = new Set(['CREATED', 'OPEN', 'FULL', 'READY', 'LOBBY']);
const JOINABLE_STATUSES = new Set(['CREATED', 'OPEN', 'READY', 'LOBBY']);

export interface LeagueBroadcastEmitter {
  emitToLeagueLobby(leagueId: string, event: string, payload: unknown): void;
}

let leagueEmitter: LeagueBroadcastEmitter | null = null;
export function registerLeagueEmitter(emitter: LeagueBroadcastEmitter) {
  leagueEmitter = emitter;
}

function emitLobby(leagueId: string, event = 'league:updated', payload: Record<string, unknown> = {}) {
  if (leagueEmitter) {
    leagueEmitter.emitToLeagueLobby(leagueId, event, { leagueId, timestamp: Date.now(), ...payload });
  }
}

export function generateInviteCode(): string {
  return `CV-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

export interface CreateLeagueInput {
  name: string;
  description?: string;
  logoUrl?: string | null;
  visibility: 'PRIVATE' | 'PUBLIC';
  maxTeams: number;
  numberOfTeams?: number;
  purseAmount: number;
  minBasePrice?: number;
  minSquadSize: number;
  maxSquadSize: number;
  bidIncrement: number;
  timerSeconds: number;
  auctionMode: 'MEGA' | 'MINI' | 'FAST_TRACK';
  teamName: string;
  teamShortName: string;
  teamLogoUrl?: string | null;
  teamPrimaryColor?: string;
  inviteCodeExpiresInHours?: number | null;
  settings?: {
    minBatsmen?: number;
    minBowlers?: number;
    minAllRounders?: number;
    minWicketkeepers?: number;
    maxOverseas?: number;
    allowAutoPick?: boolean;
    allowTeamCustomization?: boolean;
  };
}

export async function createLeague(userId: string, input: CreateLeagueInput) {
  try {
    return await db.transaction(async (tx) => {
      const inviteCode = generateInviteCode();
      const expiresAt =
        input.inviteCodeExpiresInHours && input.inviteCodeExpiresInHours > 0
          ? new Date(Date.now() + input.inviteCodeExpiresInHours * 3600_000)
          : null;

      const [creatorProfile] = await tx
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId))
        .limit(1);

      const [league] = await tx
        .insert(leagues)
        .values({
          name: input.name.trim(),
          description: (input.description || '').trim().slice(0, 300),
          logoUrl: input.logoUrl || null,
          inviteCode,
          inviteCodeActive: true,
          inviteCodeExpiresAt: expiresAt,
          visibility: input.visibility,
          ownerId: userId,
          status: 'OPEN',
          maxTeams: input.maxTeams,
          numberOfTeams: input.numberOfTeams ?? input.maxTeams,
          purseAmount: input.purseAmount,
          minBasePrice: input.minBasePrice ?? 20,
          minSquadSize: input.minSquadSize,
          maxSquadSize: input.maxSquadSize,
          bidIncrement: input.bidIncrement,
          timerSeconds: input.timerSeconds,
          auctionMode: input.auctionMode,
        })
        .returning();

      const [settings] = await tx
        .insert(leagueSettings)
        .values({
          leagueId: league.id,
          minBatsmen: input.settings?.minBatsmen ?? 4,
          minBowlers: input.settings?.minBowlers ?? 4,
          minAllRounders: input.settings?.minAllRounders ?? 2,
          minWicketkeepers: input.settings?.minWicketkeepers ?? 1,
          maxOverseas: input.settings?.maxOverseas ?? 8,
          allowAutoPick: input.settings?.allowAutoPick ?? false,
          allowTeamCustomization: input.settings?.allowTeamCustomization ?? true,
        })
        .returning();

      await tx.insert(leagueMembers).values({
        leagueId: league.id,
        userId,
        role: 'OWNER',
        isReady: true,
      });

      const requestedColor =
        input.teamPrimaryColor && /^#[0-9A-Fa-f]{6}$/.test(input.teamPrimaryColor)
          ? input.teamPrimaryColor.toUpperCase()
          : TEAM_PALETTE[0];

      const [team] = await tx
        .insert(teams)
        .values({
          leagueId: league.id,
          ownerId: userId,
          name: input.teamName.trim(),
          shortName: input.teamShortName.trim().toUpperCase().slice(0, 4),
          primaryColor: requestedColor,
          logoUrl: input.teamLogoUrl || null,
          totalPurse: input.purseAmount,
          remainingPurse: input.purseAmount,
          squadCount: 0,
        })
        .returning();

      await tx.insert(auctions).values({
        leagueId: league.id,
        name: `${league.name} Auction`,
        state: 'WAITING',
        timerSeconds: input.timerSeconds || 20,
      });

      await tx.insert(leagueActivity).values({
        leagueId: league.id,
        actorUserId: userId,
        actionType: 'LEAGUE_CREATED',
        message: `${creatorProfile?.displayName || 'League Owner'} created ${league.name} (${league.visibility})`,
        metadata: { maxTeams: league.maxTeams, inviteCode },
      });

      await tx.insert(auditLogs).values({
        actorUserId: userId,
        action: 'LEAGUE_CREATED',
        resourceType: 'LEAGUE',
        resourceId: league.id,
        details: { maxTeams: input.maxTeams, purseAmount: input.purseAmount, visibility: input.visibility },
      });

      return { league, settings, team };
    });
  } catch (error) {
    logEvent('ERROR', 'LeagueService', 'createLeague failed', { userId, error: String(error) });
    throw new Error('Failed to create league.', { cause: error });
  }
}

async function addMemberAndTeamInTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  league: typeof leagues.$inferSelect,
  userId: string,
  teamName: string,
  teamShortName: string,
  teamLogoUrl?: string | null,
  joinedViaCode?: string,
  teamPrimaryColor?: string
) {
  const existingMembers = await tx
    .select()
    .from(leagueMembers)
    .where(eq(leagueMembers.leagueId, league.id));

  const alreadyMember = existingMembers.find((m) => m.userId === userId);
  if (alreadyMember) {
    throw new Error('ALREADY_MEMBER');
  }

  if (league.status === 'CANCELLED') {
    throw new Error('LEAGUE_CANCELLED');
  }
  if (!PRE_AUCTION_STATUSES.has(league.status)) {
    throw new Error('LEAGUE_ALREADY_STARTED');
  }
  if (existingMembers.length >= league.maxTeams || league.status === 'FULL') {
    throw new Error('LEAGUE_FULL');
  }

  const existingTeams = await tx.select().from(teams).where(eq(teams.leagueId, league.id));
  const cleanTeamName = teamName.trim().slice(0, 40) || `Franchise ${existingMembers.length + 1}`;
  const cleanShort = teamShortName.trim().toUpperCase().slice(0, 4) || `FR${existingMembers.length + 1}`;

  if (existingTeams.some((t) => t.name.trim().toLowerCase() === cleanTeamName.toLowerCase())) {
    throw new Error('DUPLICATE_TEAM_NAME');
  }

  const usedColors = new Set(existingTeams.map((t) => t.primaryColor.toUpperCase()));
  const requestedColor =
    teamPrimaryColor && /^#[0-9A-Fa-f]{6}$/.test(teamPrimaryColor)
      ? teamPrimaryColor.toUpperCase()
      : null;
  const color =
    (requestedColor && !usedColors.has(requestedColor) ? requestedColor : null) ??
    TEAM_PALETTE.find((c) => !usedColors.has(c.toUpperCase())) ??
    requestedColor ??
    TEAM_PALETTE[existingMembers.length % TEAM_PALETTE.length];

  await tx.insert(leagueMembers).values({
    leagueId: league.id,
    userId,
    role: 'MEMBER',
    isReady: false,
  });

  const [team] = await tx
    .insert(teams)
    .values({
      leagueId: league.id,
      ownerId: userId,
      name: cleanTeamName,
      shortName: cleanShort,
      primaryColor: color,
      logoUrl: teamLogoUrl || null,
      totalPurse: league.purseAmount,
      remainingPurse: league.purseAmount,
      squadCount: 0,
    })
    .returning();

  const nextCount = existingMembers.length + 1;
  const nextStatus = nextCount >= league.maxTeams ? 'FULL' : league.status === 'CREATED' ? 'OPEN' : league.status;

  const [updatedLeague] = await tx
    .update(leagues)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(leagues.id, league.id))
    .returning();

  const [joinerProfile] = await tx
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  if (league.ownerId !== userId) {
    await tx.insert(notifications).values({
      userId: league.ownerId,
      type: 'LEAGUE_JOINED',
      title: `New Member in ${league.name}`,
      message: `${joinerProfile?.displayName || 'A player'} (${joinerProfile?.uniquePlayerId || ''}) joined as ${cleanTeamName}.`,
      metadata: { leagueId: league.id, teamId: team.id },
    });
  }

  await tx.insert(leagueActivity).values({
    leagueId: league.id,
    actorUserId: userId,
    actionType: 'MEMBER_JOINED',
    message: `${joinerProfile?.displayName || 'Franchise Owner'} joined with ${cleanTeamName} (${cleanShort})`,
    metadata: { teamId: team.id, joinedViaCode: joinedViaCode || null },
  });

  await tx.insert(auditLogs).values({
    actorUserId: userId,
    action: 'LEAGUE_JOINED',
    resourceType: 'LEAGUE',
    resourceId: league.id,
    details: { teamId: team.id, joinedViaCode: joinedViaCode || null },
  });

  return { league: updatedLeague, team };
}

export async function validateInviteCodePreview(userId: string, inviteCode: string) {
  const normalized = inviteCode.trim().toUpperCase();
  const [league] = await db
    .select()
    .from(leagues)
    .where(eq(leagues.inviteCode, normalized))
    .limit(1);

  if (!league) throw new Error('LEAGUE_NOT_FOUND');
  if (!league.inviteCodeActive) throw new Error('INVITE_REVOKED');
  if (league.inviteCodeExpiresAt && league.inviteCodeExpiresAt.getTime() < Date.now()) {
    throw new Error('INVITE_EXPIRED');
  }

  const [ownerProfile] = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, league.ownerId))
    .limit(1);

  const members = await db
    .select({ userId: leagueMembers.userId })
    .from(leagueMembers)
    .where(eq(leagueMembers.leagueId, league.id));

  return {
    league: {
      id: league.id,
      name: league.name,
      description: league.description,
      logoUrl: league.logoUrl,
      visibility: league.visibility,
      status: league.status,
      maxTeams: league.maxTeams,
      purseAmount: league.purseAmount,
      minBasePrice: league.minBasePrice ?? 20,
      auctionMode: league.auctionMode,
      timerSeconds: league.timerSeconds,
      bidIncrement: league.bidIncrement,
      minSquadSize: league.minSquadSize,
      maxSquadSize: league.maxSquadSize,
      ownerName: ownerProfile?.displayName || 'League Owner',
      ownerPlayerId: ownerProfile?.uniquePlayerId || null,
      memberCount: members.length,
    },
    alreadyMember: members.some((m) => m.userId === userId),
    isFull: members.length >= league.maxTeams || league.status === 'FULL',
    joinable:
      JOINABLE_STATUSES.has(league.status) &&
      members.length < league.maxTeams &&
      !members.some((m) => m.userId === userId),
  };
}

export async function joinLeagueByCode(
  userId: string,
  inviteCode: string,
  teamName: string,
  teamShortName: string,
  teamLogoUrl?: string | null,
  teamPrimaryColor?: string
) {
  try {
    const res = await db.transaction(async (tx) => {
      const normalized = inviteCode.trim().toUpperCase();
      const [league] = await tx
        .select()
        .from(leagues)
        .where(eq(leagues.inviteCode, normalized))
        .for('update')
        .limit(1);

      if (!league) throw new Error('LEAGUE_NOT_FOUND');
      if (!league.inviteCodeActive) throw new Error('INVITE_REVOKED');
      if (league.inviteCodeExpiresAt && league.inviteCodeExpiresAt.getTime() < Date.now()) {
        throw new Error('INVITE_EXPIRED');
      }

      return await addMemberAndTeamInTx(
        tx,
        league,
        userId,
        teamName,
        teamShortName,
        teamLogoUrl,
        normalized,
        teamPrimaryColor
      );
    });
    emitLobby(res.league.id, 'league:updated', { action: 'MEMBER_JOINED' });
    return { ...res, alreadyJoined: false };
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'LEAGUE_NOT_FOUND',
        'INVITE_REVOKED',
        'INVITE_EXPIRED',
        'ALREADY_MEMBER',
        'DUPLICATE_TEAM_NAME',
        'LEAGUE_CANCELLED',
        'LEAGUE_ALREADY_STARTED',
        'LEAGUE_FULL',
      ].includes(error.message)
    ) {
      throw error;
    }
    logEvent('ERROR', 'LeagueService', 'joinLeagueByCode failed', { userId, inviteCode, error: String(error) });
    throw new Error('Failed to join league.', { cause: error });
  }
}

export async function joinPublicLeagueById(
  userId: string,
  leagueId: string,
  teamName: string,
  teamShortName: string,
  teamLogoUrl?: string | null,
  teamPrimaryColor?: string
) {
  try {
    const res = await db.transaction(async (tx) => {
      const [league] = await tx
        .select()
        .from(leagues)
        .where(eq(leagues.id, leagueId))
        .for('update')
        .limit(1);

      if (!league) throw new Error('LEAGUE_NOT_FOUND');
      if (league.visibility !== 'PUBLIC') throw new Error('PRIVATE_LEAGUE_REQUIRES_INVITE');

      return await addMemberAndTeamInTx(
        tx,
        league,
        userId,
        teamName,
        teamShortName,
        teamLogoUrl,
        undefined,
        teamPrimaryColor
      );
    });
    emitLobby(res.league.id, 'league:updated', { action: 'MEMBER_JOINED' });
    return res;
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'LEAGUE_NOT_FOUND',
        'PRIVATE_LEAGUE_REQUIRES_INVITE',
        'ALREADY_MEMBER',
        'DUPLICATE_TEAM_NAME',
        'LEAGUE_CANCELLED',
        'LEAGUE_ALREADY_STARTED',
        'LEAGUE_FULL',
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error('Failed to join public league.', { cause: error });
  }
}

export async function toggleReadyStatus(userId: string, leagueId: string, isReady: boolean) {
  try {
    const [updated] = await db
      .update(leagueMembers)
      .set({ isReady })
      .where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, userId)))
      .returning();

    if (!updated) throw new Error('NOT_A_MEMBER');
    emitLobby(leagueId, 'league:updated', { action: 'READY_TOGGLED' });
    return updated;
  } catch (error) {
    if (error instanceof Error && error.message === 'NOT_A_MEMBER') throw error;
    throw new Error('Failed to update ready status.', { cause: error });
  }
}

export interface UpdateLeagueSettingsInput {
  name?: string;
  description?: string;
  logoUrl?: string | null;
  visibility?: 'PRIVATE' | 'PUBLIC';
  maxTeams?: number;
  numberOfTeams?: number;
  purseAmount?: number;
  minBasePrice?: number;
  minSquadSize?: number;
  maxSquadSize?: number;
  bidIncrement?: number;
  timerSeconds?: number;
  auctionMode?: 'MEGA' | 'MINI' | 'FAST_TRACK';
  allowTeamCustomization?: boolean;
  minBatsmen?: number;
  minBowlers?: number;
  minAllRounders?: number;
  minWicketkeepers?: number;
  maxOverseas?: number;
}

export async function updateLeagueSettings(
  actorUserId: string,
  leagueId: string,
  input: UpdateLeagueSettingsInput
) {
  const result = await db.transaction(async (tx) => {
    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for('update')
      .limit(1);

    if (!league) throw new Error('LEAGUE_NOT_FOUND');
    if (league.ownerId !== actorUserId) throw new Error('FORBIDDEN_OWNER_ONLY');
    if (!PRE_AUCTION_STATUSES.has(league.status)) {
      throw new Error('CANNOT_EDIT_AFTER_AUCTION_START');
    }

    const members = await tx
      .select()
      .from(leagueMembers)
      .where(eq(leagueMembers.leagueId, leagueId));

    const nextMaxTeams = input.maxTeams ?? league.maxTeams;
    if (nextMaxTeams < members.length) {
      throw new Error('MAX_TEAMS_BELOW_MEMBER_COUNT');
    }

    const nextMinSquad = input.minSquadSize ?? league.minSquadSize;
    const nextMaxSquad = input.maxSquadSize ?? league.maxSquadSize;
    if (nextMaxSquad < nextMinSquad) {
      throw new Error('INVALID_SQUAD_RANGE');
    }

    const nextPurse = input.purseAmount ?? league.purseAmount;
    const nextStatus =
      members.length >= nextMaxTeams
        ? 'FULL'
        : league.status === 'FULL'
        ? 'OPEN'
        : league.status;

    const [updatedLeague] = await tx
      .update(leagues)
      .set({
        name: input.name ? input.name.trim() : league.name,
        description: input.description !== undefined ? input.description.trim().slice(0, 300) : league.description,
        logoUrl: input.logoUrl !== undefined ? input.logoUrl : league.logoUrl,
        visibility: input.visibility ?? league.visibility,
        maxTeams: nextMaxTeams,
        numberOfTeams: input.numberOfTeams ?? nextMaxTeams,
        purseAmount: nextPurse,
        minBasePrice: input.minBasePrice ?? league.minBasePrice ?? 20,
        minSquadSize: nextMinSquad,
        maxSquadSize: nextMaxSquad,
        bidIncrement: input.bidIncrement ?? league.bidIncrement,
        timerSeconds: input.timerSeconds ?? league.timerSeconds,
        auctionMode: input.auctionMode ?? league.auctionMode,
        status: nextStatus,
        updatedAt: new Date(),
      })
      .where(eq(leagues.id, leagueId))
      .returning();

    const [currentSettings] = await tx
      .select()
      .from(leagueSettings)
      .where(eq(leagueSettings.leagueId, leagueId))
      .limit(1);

    const [updatedSettings] = currentSettings
      ? await tx
          .update(leagueSettings)
          .set({
            allowTeamCustomization: input.allowTeamCustomization ?? currentSettings.allowTeamCustomization,
            minBatsmen: input.minBatsmen ?? currentSettings.minBatsmen,
            minBowlers: input.minBowlers ?? currentSettings.minBowlers,
            minAllRounders: input.minAllRounders ?? currentSettings.minAllRounders,
            minWicketkeepers: input.minWicketkeepers ?? currentSettings.minWicketkeepers,
            maxOverseas: input.maxOverseas ?? currentSettings.maxOverseas,
          })
          .where(eq(leagueSettings.leagueId, leagueId))
          .returning()
      : [];

    if (nextPurse !== league.purseAmount) {
      await tx
        .update(teams)
        .set({ totalPurse: nextPurse, remainingPurse: nextPurse })
        .where(eq(teams.leagueId, leagueId));
    }

    if (input.timerSeconds !== undefined) {
      await tx
        .update(auctions)
        .set({ timerSeconds: input.timerSeconds, updatedAt: new Date() })
        .where(eq(auctions.leagueId, leagueId));
    }

    const [actorProfile] = await tx
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, actorUserId))
      .limit(1);

    await tx.insert(leagueActivity).values({
      leagueId,
      actorUserId,
      actionType: 'SETTINGS_UPDATED',
      message: `${actorProfile?.displayName || 'League Owner'} updated league rules and settings.`,
    });

    return { league: updatedLeague, settings: updatedSettings };
  });

  emitLobby(leagueId, 'league:updated', { action: 'SETTINGS_UPDATED' });
  return result;
}

export async function customizeMyTeam(
  userId: string,
  leagueId: string,
  input: { teamName: string; shortName: string; logoUrl?: string | null; primaryColor?: string }
) {
  const updatedTeam = await db.transaction(async (tx) => {
    const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
    if (!league) throw new Error('LEAGUE_NOT_FOUND');
    if (!PRE_AUCTION_STATUSES.has(league.status)) throw new Error('CANNOT_EDIT_AFTER_AUCTION_START');

    const [settings] = await tx
      .select()
      .from(leagueSettings)
      .where(eq(leagueSettings.leagueId, leagueId))
      .limit(1);

    if (league.ownerId !== userId && settings && !settings.allowTeamCustomization) {
      throw new Error('TEAM_CUSTOMIZATION_DISABLED');
    }

    const [team] = await tx
      .select()
      .from(teams)
      .where(and(eq(teams.leagueId, leagueId), eq(teams.ownerId, userId)))
      .limit(1);
    if (!team) throw new Error('NOT_A_MEMBER');

    const cleanName = input.teamName.trim().slice(0, 40);
    const cleanShort = input.shortName.trim().toUpperCase().slice(0, 4);

    const otherTeams = await tx.select().from(teams).where(eq(teams.leagueId, leagueId));
    if (
      otherTeams.some(
        (t) => t.id !== team.id && t.name.trim().toLowerCase() === cleanName.toLowerCase()
      )
    ) {
      throw new Error('DUPLICATE_TEAM_NAME');
    }

    const [saved] = await tx
      .update(teams)
      .set({
        name: cleanName,
        shortName: cleanShort,
        logoUrl: input.logoUrl !== undefined ? input.logoUrl : team.logoUrl,
        primaryColor: input.primaryColor || team.primaryColor,
      })
      .where(eq(teams.id, team.id))
      .returning();

    const [profile] = await tx
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);

    await tx.insert(leagueActivity).values({
      leagueId,
      actorUserId: userId,
      actionType: 'TEAM_CUSTOMIZED',
      message: `${profile?.displayName || 'Owner'} customized franchise to ${cleanName} (${cleanShort})`,
    });

    return saved;
  });

  emitLobby(leagueId, 'league:updated', { action: 'TEAM_CUSTOMIZED' });
  return updatedTeam;
}

export async function removeMemberFromLeague(actorUserId: string, leagueId: string, targetUserId: string) {
  const result = await db.transaction(async (tx) => {
    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for('update')
      .limit(1);

    if (!league) throw new Error('LEAGUE_NOT_FOUND');
    if (league.ownerId !== actorUserId) throw new Error('FORBIDDEN_OWNER_ONLY');
    if (!PRE_AUCTION_STATUSES.has(league.status)) throw new Error('CANNOT_EDIT_AFTER_AUCTION_START');
    if (targetUserId === league.ownerId) throw new Error('CANNOT_REMOVE_OWNER');

    const deletedMembers = await tx
      .delete(leagueMembers)
      .where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, targetUserId)))
      .returning();

    if (deletedMembers.length === 0) throw new Error('MEMBER_NOT_FOUND');

    await tx
      .delete(teams)
      .where(and(eq(teams.leagueId, leagueId), eq(teams.ownerId, targetUserId)));

    const remaining = await tx
      .select()
      .from(leagueMembers)
      .where(eq(leagueMembers.leagueId, leagueId));

    const nextStatus =
      league.status === 'FULL' || (league.status === 'READY' && remaining.length < 2)
        ? 'OPEN'
        : league.status;

    const [updatedLeague] = await tx
      .update(leagues)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(leagues.id, leagueId))
      .returning();

    const [targetProfile] = await tx
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, targetUserId))
      .limit(1);

    await tx.insert(notifications).values({
      userId: targetUserId,
      type: 'LEAGUE_UPDATE',
      title: `Removed from ${league.name}`,
      message: `The league owner removed your franchise from ${league.name} before the auction started.`,
      metadata: { leagueId },
    });

    await tx.insert(leagueActivity).values({
      leagueId,
      actorUserId,
      actionType: 'MEMBER_REMOVED',
      message: `${targetProfile?.displayName || 'Member'} was removed from the league.`,
    });

    return { league: updatedLeague, removedUserId: targetUserId };
  });

  emitLobby(leagueId, 'league:updated', { action: 'MEMBER_REMOVED' });
  return result;
}

export async function leaveLeague(userId: string, leagueId: string) {
  const result = await db.transaction(async (tx) => {
    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for('update')
      .limit(1);

    if (!league) throw new Error('LEAGUE_NOT_FOUND');
    if (league.ownerId === userId) throw new Error('OWNER_MUST_TRANSFER_BEFORE_LEAVING');
    if (!PRE_AUCTION_STATUSES.has(league.status)) throw new Error('CANNOT_LEAVE_AFTER_AUCTION_START');

    const deleted = await tx
      .delete(leagueMembers)
      .where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, userId)))
      .returning();
    if (deleted.length === 0) throw new Error('NOT_A_MEMBER');

    await tx.delete(teams).where(and(eq(teams.leagueId, leagueId), eq(teams.ownerId, userId)));

    const remaining = await tx
      .select()
      .from(leagueMembers)
      .where(eq(leagueMembers.leagueId, leagueId));

    const nextStatus =
      league.status === 'FULL' || (league.status === 'READY' && remaining.length < 2)
        ? 'OPEN'
        : league.status;

    const [updatedLeague] = await tx
      .update(leagues)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(leagues.id, leagueId))
      .returning();

    const [profile] = await tx
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);

    await tx.insert(notifications).values({
      userId: league.ownerId,
      type: 'LEAGUE_UPDATE',
      title: `Member Left ${league.name}`,
      message: `${profile?.displayName || 'A member'} left ${league.name}.`,
      metadata: { leagueId },
    });

    await tx.insert(leagueActivity).values({
      leagueId,
      actorUserId: userId,
      actionType: 'MEMBER_LEFT',
      message: `${profile?.displayName || 'Member'} left the league.`,
    });

    return { league: updatedLeague };
  });

  emitLobby(leagueId, 'league:updated', { action: 'MEMBER_LEFT' });
  return result;
}

export async function transferLeagueOwnership(
  actorUserId: string,
  leagueId: string,
  newOwnerUserId: string
) {
  const result = await db.transaction(async (tx) => {
    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for('update')
      .limit(1);

    if (!league) throw new Error('LEAGUE_NOT_FOUND');
    if (league.ownerId !== actorUserId) throw new Error('FORBIDDEN_OWNER_ONLY');
    if (!PRE_AUCTION_STATUSES.has(league.status)) throw new Error('CANNOT_EDIT_AFTER_AUCTION_START');
    if (newOwnerUserId === actorUserId) throw new Error('ALREADY_OWNER');

    const [targetMember] = await tx
      .select()
      .from(leagueMembers)
      .where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, newOwnerUserId)))
      .limit(1);

    if (!targetMember) throw new Error('TARGET_NOT_MEMBER');

    const [updatedLeague] = await tx
      .update(leagues)
      .set({ ownerId: newOwnerUserId, updatedAt: new Date() })
      .where(eq(leagues.id, leagueId))
      .returning();

    await tx
      .update(leagueMembers)
      .set({ role: 'MEMBER' })
      .where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, actorUserId)));

    await tx
      .update(leagueMembers)
      .set({ role: 'OWNER', isReady: true })
      .where(and(eq(leagueMembers.leagueId, leagueId), eq(leagueMembers.userId, newOwnerUserId)));

    const [newOwnerProfile] = await tx
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, newOwnerUserId))
      .limit(1);

    await tx.insert(notifications).values({
      userId: newOwnerUserId,
      type: 'LEAGUE_UPDATE',
      title: `Ownership Transferred: ${league.name}`,
      message: `You are now the League Owner of ${league.name}.`,
      metadata: { leagueId },
    });

    await tx.insert(leagueActivity).values({
      leagueId,
      actorUserId,
      actionType: 'OWNERSHIP_TRANSFERRED',
      message: `League ownership transferred to ${newOwnerProfile?.displayName || 'New Owner'}.`,
    });

    return { league: updatedLeague };
  });

  emitLobby(leagueId, 'league:updated', { action: 'OWNERSHIP_TRANSFERRED' });
  return result;
}

export async function cancelLeague(actorUserId: string, leagueId: string) {
  const updated = await db.transaction(async (tx) => {
    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for('update')
      .limit(1);

    if (!league) throw new Error('LEAGUE_NOT_FOUND');
    if (league.ownerId !== actorUserId) throw new Error('FORBIDDEN_OWNER_ONLY');
    if (!PRE_AUCTION_STATUSES.has(league.status)) throw new Error('CANNOT_CANCEL_AFTER_AUCTION_START');

    const [cancelled] = await tx
      .update(leagues)
      .set({ status: 'CANCELLED', inviteCodeActive: false, updatedAt: new Date() })
      .where(eq(leagues.id, leagueId))
      .returning();

    await tx
      .update(leagueInvitations)
      .set({ status: 'REVOKED', updatedAt: new Date() })
      .where(and(eq(leagueInvitations.leagueId, leagueId), eq(leagueInvitations.status, 'PENDING')));

    await tx.insert(leagueActivity).values({
      leagueId,
      actorUserId,
      actionType: 'LEAGUE_CANCELLED',
      message: `${league.name} was closed and cancelled by the league owner.`,
    });

    return cancelled;
  });

  emitLobby(leagueId, 'league:updated', { action: 'LEAGUE_CANCELLED' });
  return updated;
}

export async function markLeagueReady(actorUserId: string, leagueId: string, ready: boolean) {
  const updated = await db.transaction(async (tx) => {
    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for('update')
      .limit(1);

    if (!league) throw new Error('LEAGUE_NOT_FOUND');
    if (league.ownerId !== actorUserId) throw new Error('FORBIDDEN_OWNER_ONLY');
    if (!PRE_AUCTION_STATUSES.has(league.status)) throw new Error('CANNOT_EDIT_AFTER_AUCTION_START');

    const members = await tx
      .select()
      .from(leagueMembers)
      .where(eq(leagueMembers.leagueId, leagueId));

    if (ready && members.length < 2) {
      throw new Error('MIN_TWO_TEAMS_REQUIRED');
    }

    const nextStatus = ready
      ? 'READY'
      : members.length >= league.maxTeams
      ? 'FULL'
      : 'OPEN';

    const [saved] = await tx
      .update(leagues)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(leagues.id, leagueId))
      .returning();

    await tx.insert(leagueActivity).values({
      leagueId,
      actorUserId,
      actionType: 'LEAGUE_READY',
      message: ready ? `${league.name} marked READY for player auction.` : `${league.name} reopened for lobby adjustments.`,
    });

    return saved;
  });

  emitLobby(leagueId, 'league:updated', { action: 'STATUS_CHANGED' });
  return updated;
}

export async function regenerateInviteCode(
  actorUserId: string,
  leagueId: string,
  expiresInHours?: number | null
) {
  const updated = await db.transaction(async (tx) => {
    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for('update')
      .limit(1);

    if (!league) throw new Error('LEAGUE_NOT_FOUND');
    if (league.ownerId !== actorUserId) throw new Error('FORBIDDEN_OWNER_ONLY');
    if (!PRE_AUCTION_STATUSES.has(league.status)) throw new Error('CANNOT_EDIT_AFTER_AUCTION_START');

    const newCode = generateInviteCode();
    const expiresAt =
      expiresInHours && expiresInHours > 0 ? new Date(Date.now() + expiresInHours * 3600_000) : null;

    const [saved] = await tx
      .update(leagues)
      .set({
        inviteCode: newCode,
        inviteCodeActive: true,
        inviteCodeExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(leagues.id, leagueId))
      .returning();

    await tx.insert(leagueActivity).values({
      leagueId,
      actorUserId,
      actionType: 'CODE_REGENERATED',
      message: `Owner generated a fresh invitation code (${newCode}).`,
    });

    return saved;
  });

  emitLobby(leagueId, 'league:updated', { action: 'CODE_REGENERATED' });
  return updated;
}

export async function revokeInviteCode(actorUserId: string, leagueId: string) {
  const updated = await db.transaction(async (tx) => {
    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .for('update')
      .limit(1);

    if (!league) throw new Error('LEAGUE_NOT_FOUND');
    if (league.ownerId !== actorUserId) throw new Error('FORBIDDEN_OWNER_ONLY');
    if (!PRE_AUCTION_STATUSES.has(league.status)) throw new Error('CANNOT_EDIT_AFTER_AUCTION_START');

    const [saved] = await tx
      .update(leagues)
      .set({ inviteCodeActive: false, updatedAt: new Date() })
      .where(eq(leagues.id, leagueId))
      .returning();

    await tx
      .update(leagueInvitations)
      .set({ status: 'REVOKED', updatedAt: new Date() })
      .where(and(eq(leagueInvitations.leagueId, leagueId), eq(leagueInvitations.status, 'PENDING')));

    await tx.insert(leagueActivity).values({
      leagueId,
      actorUserId,
      actionType: 'CODE_REGENERATED',
      message: `Owner revoked the active invitation code.`,
    });

    return saved;
  });

  emitLobby(leagueId, 'league:updated', { action: 'CODE_REVOKED' });
  return updated;
}

export async function inviteFriendToLeague(
  senderId: string,
  leagueId: string,
  target: { targetUserId?: string; uniquePlayerId?: string }
) {
  try {
    const result = await db.transaction(async (tx) => {
      const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
      if (!league) throw new Error('LEAGUE_NOT_FOUND');
      if (!JOINABLE_STATUSES.has(league.status)) throw new Error('LEAGUE_NOT_JOINABLE');

      const members = await tx
        .select()
        .from(leagueMembers)
        .where(eq(leagueMembers.leagueId, leagueId));

      const senderMembership = members.find((m) => m.userId === senderId);
      if (!senderMembership) throw new Error('FORBIDDEN');
      if (members.length >= league.maxTeams) throw new Error('LEAGUE_FULL');

      let recipientUserId = target.targetUserId;
      if (!recipientUserId && target.uniquePlayerId) {
        const cleanPid = target.uniquePlayerId.trim().toUpperCase();
        const [found] = await tx
          .select()
          .from(userProfiles)
          .where(eq(userProfiles.uniquePlayerId, cleanPid))
          .limit(1);
        if (!found) throw new Error('PLAYER_NOT_FOUND');
        recipientUserId = found.userId;
      }
      if (!recipientUserId) throw new Error('PLAYER_NOT_FOUND');
      if (recipientUserId === senderId) throw new Error('CANNOT_INVITE_SELF');
      if (members.some((m) => m.userId === recipientUserId)) throw new Error('ALREADY_MEMBER');

      const [existingPending] = await tx
        .select()
        .from(leagueInvitations)
        .where(
          and(
            eq(leagueInvitations.leagueId, leagueId),
            eq(leagueInvitations.recipientId, recipientUserId),
            eq(leagueInvitations.status, 'PENDING')
          )
        )
        .limit(1);
      if (existingPending) throw new Error('INVITE_ALREADY_PENDING');

      const [senderProfile] = await tx
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, senderId))
        .limit(1);
      const [recipientProfile] = await tx
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, recipientUserId))
        .limit(1);

      const [invitation] = await tx
        .insert(leagueInvitations)
        .values({
          leagueId: league.id,
          type: 'DIRECT_INVITE',
          senderId,
          recipientId: recipientUserId,
          inviteCode: league.inviteCode,
          status: 'PENDING',
          expiresAt: league.inviteCodeExpiresAt,
        })
        .returning();

      const [notification] = await tx
        .insert(notifications)
        .values({
          userId: recipientUserId,
          type: 'LEAGUE_INVITE',
          title: `League Invite: ${league.name}`,
          message: `${senderProfile?.displayName || 'A friend'} invited you to join ${league.name} (${league.inviteCode}).`,
          metadata: {
            leagueId: league.id,
            inviteCode: league.inviteCode,
            invitationId: invitation.id,
            senderId,
          },
        })
        .returning();

      await tx.insert(leagueActivity).values({
        leagueId: league.id,
        actorUserId: senderId,
        actionType: 'INVITE_SENT',
        message: `${senderProfile?.displayName || 'Member'} invited ${recipientProfile?.displayName || 'Player'} (${recipientProfile?.uniquePlayerId || ''}).`,
      });

      return { invitation, notification, recipientUid: recipientUserId };
    });

    emitLobby(leagueId, 'league:updated', { action: 'INVITE_SENT' });
    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'LEAGUE_NOT_FOUND',
        'LEAGUE_NOT_JOINABLE',
        'FORBIDDEN',
        'LEAGUE_FULL',
        'PLAYER_NOT_FOUND',
        'CANNOT_INVITE_SELF',
        'ALREADY_MEMBER',
        'INVITE_ALREADY_PENDING',
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error('Failed to send league invite.', { cause: error });
  }
}

export async function requestToJoinLeague(userId: string, leagueId: string) {
  const result = await db.transaction(async (tx) => {
    const [league] = await tx.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
    if (!league) throw new Error('LEAGUE_NOT_FOUND');
    if (!JOINABLE_STATUSES.has(league.status)) throw new Error('LEAGUE_NOT_JOINABLE');

    const members = await tx
      .select()
      .from(leagueMembers)
      .where(eq(leagueMembers.leagueId, leagueId));
    if (members.some((m) => m.userId === userId)) throw new Error('ALREADY_MEMBER');
    if (members.length >= league.maxTeams) throw new Error('LEAGUE_FULL');

    const [existingPending] = await tx
      .select()
      .from(leagueInvitations)
      .where(
        and(
          eq(leagueInvitations.leagueId, leagueId),
          eq(leagueInvitations.senderId, userId),
          eq(leagueInvitations.type, 'JOIN_REQUEST'),
          eq(leagueInvitations.status, 'PENDING')
        )
      )
      .limit(1);
    if (existingPending) throw new Error('REQUEST_ALREADY_PENDING');

    const [senderProfile] = await tx
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);

    const [invitation] = await tx
      .insert(leagueInvitations)
      .values({
        leagueId: league.id,
        type: 'JOIN_REQUEST',
        senderId: userId,
        recipientId: league.ownerId,
        inviteCode: league.inviteCode,
        status: 'PENDING',
      })
      .returning();

    await tx.insert(notifications).values({
      userId: league.ownerId,
      type: 'LEAGUE_REQUEST',
      title: `Join Request: ${league.name}`,
      message: `${senderProfile?.displayName || 'A player'} (${senderProfile?.uniquePlayerId || ''}) requested to join ${league.name}.`,
      metadata: { leagueId: league.id, invitationId: invitation.id },
    });

    await tx.insert(leagueActivity).values({
      leagueId: league.id,
      actorUserId: userId,
      actionType: 'JOIN_REQUESTED',
      message: `${senderProfile?.displayName || 'Player'} requested permission to join.`,
    });

    return { invitation };
  });

  emitLobby(leagueId, 'league:updated', { action: 'JOIN_REQUESTED' });
  return result;
}

export async function respondToLeagueInvitation(
  actorUserId: string,
  invitationId: string,
  action: 'ACCEPT' | 'REJECT' | 'REVOKE',
  teamName?: string,
  teamShortName?: string,
  teamLogoUrl?: string | null
) {
  const result = await db.transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(leagueInvitations)
      .where(eq(leagueInvitations.id, invitationId))
      .for('update')
      .limit(1);

    if (!inv) throw new Error('INVITATION_NOT_FOUND');
    if (inv.status !== 'PENDING') throw new Error('INVITATION_NOT_PENDING');

    const [league] = await tx
      .select()
      .from(leagues)
      .where(eq(leagues.id, inv.leagueId))
      .for('update')
      .limit(1);

    if (!league) throw new Error('LEAGUE_NOT_FOUND');

    if (action === 'REVOKE') {
      if (inv.senderId !== actorUserId && league.ownerId !== actorUserId) {
        throw new Error('FORBIDDEN');
      }
      const [revoked] = await tx
        .update(leagueInvitations)
        .set({ status: 'REVOKED', updatedAt: new Date() })
        .where(eq(leagueInvitations.id, invitationId))
        .returning();
      return { invitation: revoked, league };
    }

    if (inv.type === 'DIRECT_INVITE' && inv.recipientId !== actorUserId) {
      throw new Error('FORBIDDEN');
    }
    if (inv.type === 'JOIN_REQUEST' && league.ownerId !== actorUserId) {
      throw new Error('FORBIDDEN_OWNER_ONLY');
    }

    if (action === 'REJECT') {
      const [rejected] = await tx
        .update(leagueInvitations)
        .set({ status: 'REJECTED', updatedAt: new Date() })
        .where(eq(leagueInvitations.id, invitationId))
        .returning();
      return { invitation: rejected, league };
    }

    if (inv.expiresAt && inv.expiresAt.getTime() < Date.now()) {
      await tx
        .update(leagueInvitations)
        .set({ status: 'EXPIRED', updatedAt: new Date() })
        .where(eq(leagueInvitations.id, invitationId));
      throw new Error('INVITE_EXPIRED');
    }

    const joiningUserId = inv.type === 'DIRECT_INVITE' ? inv.recipientId : inv.senderId;
    const [joiningProfile] = await tx
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, joiningUserId))
      .limit(1);

    const fallbackName = `${joiningProfile?.displayName?.split(' ')[0] || 'Royal'} XI`;
    const fallbackShort = (joiningProfile?.displayName || 'CRK')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'CRK';

    const joined = await addMemberAndTeamInTx(
      tx,
      league,
      joiningUserId,
      teamName?.trim() || fallbackName,
      teamShortName?.trim() || fallbackShort,
      teamLogoUrl,
      inv.inviteCode
    );

    const [accepted] = await tx
      .update(leagueInvitations)
      .set({ status: 'ACCEPTED', updatedAt: new Date() })
      .where(eq(leagueInvitations.id, invitationId))
      .returning();

    return { invitation: accepted, ...joined };
  });

  emitLobby(result.league.id, 'league:updated', { action: `INVITATION_${action}` });
  return result;
}

export async function listUserLeagues(userId: string) {
  try {
    const memberships = await db
      .select({ leagueId: leagueMembers.leagueId })
      .from(leagueMembers)
      .where(eq(leagueMembers.userId, userId));

    const myLeagueIds = memberships.map((m) => m.leagueId);

    const myLeagues =
      myLeagueIds.length > 0
        ? await db.select().from(leagues).where(inArray(leagues.id, myLeagueIds)).orderBy(desc(leagues.createdAt))
        : [];

    const publicLeagues = await db
      .select()
      .from(leagues)
      .where(eq(leagues.visibility, 'PUBLIC'))
      .orderBy(desc(leagues.createdAt))
      .limit(30);

    const allLeagues = [...myLeagues, ...publicLeagues];
    const allIds = Array.from(new Set(allLeagues.map((l) => l.id)));
    const ownerIds = Array.from(new Set(allLeagues.map((l) => l.ownerId)));

    const [memberCounts, ownerProfiles, ownerUsers] = await Promise.all([
      allIds.length > 0
        ? db
            .select({
              leagueId: leagueMembers.leagueId,
              count: sql<number>`count(*)::int`,
            })
            .from(leagueMembers)
            .where(inArray(leagueMembers.leagueId, allIds))
            .groupBy(leagueMembers.leagueId)
        : Promise.resolve([]),
      ownerIds.length > 0
        ? db.select().from(userProfiles).where(inArray(userProfiles.userId, ownerIds))
        : Promise.resolve([]),
      ownerIds.length > 0
        ? db.select({ id: users.id, uid: users.uid }).from(users).where(inArray(users.id, ownerIds))
        : Promise.resolve([]),
    ]);

    const countMap = new Map(memberCounts.map((c) => [c.leagueId, c.count]));
    const ownerMap = new Map(ownerProfiles.map((p) => [p.userId, p]));
    const ownerUidMap = new Map(ownerUsers.map((u) => [u.id, u.uid]));
    const mySet = new Set(myLeagueIds);

    const enrich = (l: typeof leagues.$inferSelect, isMember: boolean) => {
      const owner = ownerMap.get(l.ownerId);
      return {
        ...l,
        memberCount: countMap.get(l.id) ?? 1,
        isMember,
        ownerUid: ownerUidMap.get(l.ownerId) || null,
        ownerName: owner?.displayName || 'League Owner',
        ownerPlayerId: owner?.uniquePlayerId || null,
      };
    };

    // Pending invitations (received OR sent by me OR owned leagues)
    const invRows = await db
      .select()
      .from(leagueInvitations)
      .where(
        and(
          eq(leagueInvitations.status, 'PENDING'),
          or(
            eq(leagueInvitations.recipientId, userId),
            eq(leagueInvitations.senderId, userId)
          )
        )
      )
      .orderBy(desc(leagueInvitations.createdAt))
      .limit(30);

    const invLeagueIds = Array.from(new Set(invRows.map((i) => i.leagueId)));
    const invUserIds = Array.from(new Set(invRows.flatMap((i) => [i.senderId, i.recipientId])));
    const [invLeagues, invProfiles, invUsers] = await Promise.all([
      invLeagueIds.length > 0 ? db.select().from(leagues).where(inArray(leagues.id, invLeagueIds)) : Promise.resolve([]),
      invUserIds.length > 0 ? db.select().from(userProfiles).where(inArray(userProfiles.userId, invUserIds)) : Promise.resolve([]),
      invUserIds.length > 0
        ? db.select({ id: users.id, uid: users.uid }).from(users).where(inArray(users.id, invUserIds))
        : Promise.resolve([]),
    ]);
    const invLeagueMap = new Map(invLeagues.map((l) => [l.id, l]));
    const invProfileMap = new Map(invProfiles.map((p) => [p.userId, p]));
    const invUidMap = new Map(invUsers.map((u) => [u.id, u.uid]));

    const pendingInvitations = invRows.map((i) => {
      const l = invLeagueMap.get(i.leagueId);
      const sp = invProfileMap.get(i.senderId);
      const rp = invProfileMap.get(i.recipientId);
      return {
        id: i.id,
        leagueId: i.leagueId,
        leagueName: l?.name || 'CricketVerse League',
        leagueVisibility: (l?.visibility || 'PRIVATE') as 'PRIVATE' | 'PUBLIC',
        inviteCode: i.inviteCode,
        type: i.type as 'DIRECT_INVITE' | 'JOIN_REQUEST',
        senderId: i.senderId,
        senderUid: invUidMap.get(i.senderId) || null,
        senderName: sp?.displayName || 'Owner',
        senderPlayerId: sp?.uniquePlayerId || '',
        recipientId: i.recipientId,
        recipientUid: invUidMap.get(i.recipientId) || null,
        recipientName: rp?.displayName || 'Owner',
        recipientPlayerId: rp?.uniquePlayerId || '',
        status: i.status,
        expiresAt: i.expiresAt ? i.expiresAt.toISOString() : null,
        createdAt: i.createdAt.toISOString(),
      };
    });

    // Recent league activity across user's leagues
    const actRows =
      myLeagueIds.length > 0
        ? await db
            .select()
            .from(leagueActivity)
            .where(inArray(leagueActivity.leagueId, myLeagueIds))
            .orderBy(desc(leagueActivity.createdAt))
            .limit(20)
        : [];
    const myLeagueMap = new Map(myLeagues.map((l) => [l.id, l]));
    const recentActivity = actRows.map((a) => ({
      id: a.id,
      leagueId: a.leagueId,
      leagueName: myLeagueMap.get(a.leagueId)?.name || 'League',
      actorId: a.actorUserId,
      actionType: a.actionType,
      message: a.message,
      createdAt: a.createdAt.toISOString(),
    }));

    return {
      myLeagues: myLeagues.map((l) => enrich(l, true)),
      publicLeagues: publicLeagues
        .filter((l) => !mySet.has(l.id) && l.status !== 'CANCELLED')
        .map((l) => enrich(l, false)),
      pendingInvitations,
      recentActivity,
    };
  } catch (error) {
    logEvent('ERROR', 'LeagueService', 'listUserLeagues failed', { error: String(error) });
    throw new Error('Failed to fetch leagues.', { cause: error });
  }
}

export async function getLeagueDetails(leagueId: string, userId: string) {
  try {
    const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
    if (!league) return null;

    const [settings] = await db.select().from(leagueSettings).where(eq(leagueSettings.leagueId, leagueId)).limit(1);

    const members = await db
      .select({
        id: leagueMembers.id,
        userId: leagueMembers.userId,
        uid: users.uid,
        role: leagueMembers.role,
        isReady: leagueMembers.isReady,
        joinedAt: leagueMembers.joinedAt,
        displayName: userProfiles.displayName,
        uniquePlayerId: userProfiles.uniquePlayerId,
        avatarUrl: userProfiles.avatarUrl,
        onlineStatus: userProfiles.onlineStatus,
      })
      .from(leagueMembers)
      .innerJoin(users, eq(leagueMembers.userId, users.id))
      .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
      .where(eq(leagueMembers.leagueId, leagueId));

    const isMember = members.some((m) => m.userId === userId);
    if (!isMember && league.visibility !== 'PUBLIC') {
      throw new Error('FORBIDDEN');
    }

    const leagueTeamsRaw = await db.select().from(teams).where(eq(teams.leagueId, leagueId));
    const memberMap = new Map(members.map((m) => [m.userId, m]));
    const leagueTeams = leagueTeamsRaw.map((t) => {
      const ownerMem = memberMap.get(t.ownerId);
      const squadStatus =
        t.squadCount >= league.maxSquadSize
          ? ('FULL' as const)
          : t.squadCount >= league.minSquadSize
          ? ('MEETS_MIN' as const)
          : ('UNFILLED' as const);
      return {
        ...t,
        ownerUid: ownerMem?.uid || null,
        ownerName: ownerMem?.displayName || 'Owner',
        ownerPlayerId: ownerMem?.uniquePlayerId || null,
        squadStatus,
      };
    });

    const [auction] = await db.select().from(auctions).where(eq(auctions.leagueId, leagueId)).limit(1);

    const invRows = isMember
      ? await db
          .select()
          .from(leagueInvitations)
          .where(and(eq(leagueInvitations.leagueId, leagueId), eq(leagueInvitations.status, 'PENDING')))
          .orderBy(desc(leagueInvitations.createdAt))
      : [];

    const invUserIds = Array.from(new Set(invRows.flatMap((i) => [i.senderId, i.recipientId])));
    const [invProfiles, invUsers] = await Promise.all([
      invUserIds.length > 0
        ? db.select().from(userProfiles).where(inArray(userProfiles.userId, invUserIds))
        : Promise.resolve([]),
      invUserIds.length > 0
        ? db.select({ id: users.id, uid: users.uid }).from(users).where(inArray(users.id, invUserIds))
        : Promise.resolve([]),
    ]);
    const invProfileMap = new Map(invProfiles.map((p) => [p.userId, p]));
    const invUidMap = new Map(invUsers.map((u) => [u.id, u.uid]));

    const invitations = invRows.map((i) => ({
      id: i.id,
      leagueId: i.leagueId,
      leagueName: league.name,
      leagueVisibility: league.visibility as 'PRIVATE' | 'PUBLIC',
      inviteCode: i.inviteCode,
      type: i.type as 'DIRECT_INVITE' | 'JOIN_REQUEST',
      senderId: i.senderId,
      senderUid: invUidMap.get(i.senderId) || null,
      senderName: invProfileMap.get(i.senderId)?.displayName || 'Player',
      senderPlayerId: invProfileMap.get(i.senderId)?.uniquePlayerId || '',
      recipientId: i.recipientId,
      recipientUid: invUidMap.get(i.recipientId) || null,
      recipientName: invProfileMap.get(i.recipientId)?.displayName || 'Player',
      recipientPlayerId: invProfileMap.get(i.recipientId)?.uniquePlayerId || '',
      status: i.status,
      expiresAt: i.expiresAt ? i.expiresAt.toISOString() : null,
      createdAt: i.createdAt.toISOString(),
    }));

    const activity = await db
      .select()
      .from(leagueActivity)
      .where(eq(leagueActivity.leagueId, leagueId))
      .orderBy(desc(leagueActivity.createdAt))
      .limit(25);

    const ownerProfile = memberMap.get(league.ownerId);

    return {
      league: {
        ...league,
        memberCount: members.length,
        isMember,
        ownerUid: ownerProfile?.uid || null,
        ownerName: ownerProfile?.displayName || 'League Owner',
        ownerPlayerId: ownerProfile?.uniquePlayerId || null,
      },
      settings,
      members,
      teams: leagueTeams,
      invitations,
      activity,
      auction,
      isMember,
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') throw error;
    logEvent('ERROR', 'LeagueService', 'getLeagueDetails failed', { leagueId, error: String(error) });
    throw new Error('Failed to fetch league details.', { cause: error });
  }
}
