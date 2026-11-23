import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, reportFirestoreListenerError } from '../lib/firebase.ts';
import { lookupPlayerByUniqueIdFirestore } from './firestoreService.ts';

export interface FsLeague {
  leagueId: string;
  name: string;
  description: string;
  logoUrl: string | null;
  visibility: 'PRIVATE' | 'PUBLIC';
  ownerId: string;
  ownerName: string;
  ownerPlayerId: string;
  status: 'CREATED' | 'OPEN' | 'FULL' | 'READY' | 'AUCTION_IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  maxParticipants: number;
  numberOfTeams: number;
  participantCount: number;
  memberIds: string[];
  startingPurse: number;
  squadSize: number;
  minPlayers: number;
  maxPlayers: number;
  bidIncrement: number;
  timerDuration: number;
  auctionMode: 'MEGA' | 'MINI' | 'FAST_TRACK';
  createdAt: string;
  updatedAt: string;
}

export interface FsLeagueSettings {
  leagueId: string;
  ownerId: string;
  inviteCode: string;
  inviteCodeActive: boolean;
  inviteCodeExpiresAt: string | null;
  startingPurse: number;
  squadSize: number;
  minPlayers: number;
  maxPlayers: number;
  bidIncrement: number;
  timerDuration: number;
  auctionMode: 'MEGA' | 'MINI' | 'FAST_TRACK';
  allowTeamCustomization: boolean;
  minBatsmen: number;
  minBowlers: number;
  minAllRounders: number;
  minWicketkeepers: number;
  maxOverseas: number;
}

export interface FsLeagueMember {
  leagueId: string;
  leagueOwnerId: string;
  userId: string;
  uniquePlayerId: string;
  username: string;
  photoUrl: string | null;
  role: 'OWNER' | 'MEMBER';
  isReady: boolean;
  teamId: string;
  joinedAt: string;
}

export interface FsLeagueTeam {
  teamId: string;
  leagueId: string;
  leagueOwnerId: string;
  ownerId: string;
  ownerName: string;
  ownerPlayerId: string;
  teamName: string;
  shortName: string;
  logoUrl: string | null;
  primaryColor: string;
  totalPurse: number;
  remainingPurse: number;
  playersCount: number;
  squadStatus: 'UNFILLED' | 'MEETS_MIN' | 'FULL';
}

export interface FsLeagueInvitation {
  id: string;
  leagueId: string;
  leagueName: string;
  leagueVisibility: 'PRIVATE' | 'PUBLIC';
  leagueOwnerId: string;
  inviteCode: string | null;
  type: 'DIRECT_INVITE' | 'JOIN_REQUEST';
  senderId: string;
  senderPlayerId: string;
  senderUsername: string;
  recipientId: string;
  recipientPlayerId: string;
  recipientUsername: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'REVOKED';
  expiresAt: string | null;
  createdAt: string;
}

export interface FsLeagueActivity {
  id: string;
  leagueId: string;
  leagueName: string;
  actorId: string;
  actorName: string;
  actionType: string;
  message: string;
  createdAt: string;
}

function toIso(val: unknown): string {
  if (val instanceof Timestamp) return val.toDate().toISOString();
  if (typeof val === 'string') return val;
  return new Date().toISOString();
}

function safeName(val: string | null | undefined, fallback = 'Franchise Owner'): string {
  const clean = (val || fallback).trim().slice(0, 40);
  return clean.length >= 2 ? clean : fallback;
}

function safePlayerCode(val: string | null | undefined): string {
  const clean = (val || '').trim().toUpperCase();
  return /^CV[0-9]{6,}$/.test(clean) ? clean : 'CV100001';
}

function safeInviteCode(val: string): string {
  return val.trim().toUpperCase();
}

export async function syncLeagueCreatedFirestore(params: {
  leagueId: string;
  name: string;
  description?: string;
  logoUrl?: string | null;
  visibility: 'PRIVATE' | 'PUBLIC';
  ownerUid: string;
  ownerName: string;
  ownerPlayerId: string;
  ownerPhotoUrl?: string | null;
  inviteCode: string;
  inviteCodeExpiresAt?: string | null;
  maxParticipants: number;
  numberOfTeams: number;
  startingPurse: number;
  squadSize: number;
  minPlayers: number;
  maxPlayers: number;
  bidIncrement: number;
  timerDuration: number;
  auctionMode: 'MEGA' | 'MINI' | 'FAST_TRACK';
  allowTeamCustomization: boolean;
  minBatsmen?: number;
  minBowlers?: number;
  minAllRounders?: number;
  minWicketkeepers?: number;
  maxOverseas?: number;
  teamId: string;
  teamName: string;
  teamShortName: string;
  teamLogoUrl?: string | null;
  primaryColor?: string;
}) {
  const path = `leagues/${params.leagueId}`;
  const cleanName = params.name.trim().slice(0, 60);
  const cleanOwner = safeName(params.ownerName);
  const cleanOwnerPid = safePlayerCode(params.ownerPlayerId);
  const code = safeInviteCode(params.inviteCode);
  const memberDocId = `${params.leagueId}__${params.ownerUid}`;
  const actRef = doc(collection(db, 'league_activity'));
  const now = serverTimestamp();

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'leagues', params.leagueId), {
      leagueId: params.leagueId,
      name: cleanName,
      description: (params.description || '').trim().slice(0, 300),
      logoUrl: params.logoUrl || null,
      visibility: params.visibility,
      ownerId: params.ownerUid,
      ownerName: cleanOwner,
      ownerPlayerId: cleanOwnerPid,
      status: 'OPEN',
      maxParticipants: params.maxParticipants,
      numberOfTeams: params.numberOfTeams,
      participantCount: 1,
      memberIds: [params.ownerUid],
      startingPurse: params.startingPurse,
      squadSize: params.squadSize,
      minPlayers: params.minPlayers,
      maxPlayers: params.maxPlayers,
      bidIncrement: params.bidIncrement,
      timerDuration: params.timerDuration,
      auctionMode: params.auctionMode,
      createdAt: now,
      updatedAt: now,
    });

    batch.set(doc(db, 'league_settings', params.leagueId), {
      leagueId: params.leagueId,
      ownerId: params.ownerUid,
      inviteCode: code,
      inviteCodeActive: true,
      inviteCodeExpiresAt: params.inviteCodeExpiresAt || null,
      startingPurse: params.startingPurse,
      squadSize: params.squadSize,
      minPlayers: params.minPlayers,
      maxPlayers: params.maxPlayers,
      bidIncrement: params.bidIncrement,
      timerDuration: params.timerDuration,
      auctionMode: params.auctionMode,
      allowTeamCustomization: params.allowTeamCustomization,
      minBatsmen: params.minBatsmen ?? 4,
      minBowlers: params.minBowlers ?? 4,
      minAllRounders: params.minAllRounders ?? 2,
      minWicketkeepers: params.minWicketkeepers ?? 1,
      maxOverseas: params.maxOverseas ?? 8,
      updatedAt: now,
    });

    batch.set(doc(db, 'squad_settings', params.leagueId), {
      leagueId: params.leagueId,
      ownerId: params.ownerUid,
      minSquadSize: params.minPlayers,
      maxSquadSize: params.maxPlayers,
      maxOverseas: params.maxOverseas ?? 8,
      minWicketkeepers: params.minWicketkeepers ?? 1,
      minBatsmen: params.minBatsmen ?? 4,
      minBowlers: params.minBowlers ?? 4,
      minAllRounders: params.minAllRounders ?? 2,
      updatedAt: now,
    });

    batch.set(doc(db, 'league_invite_codes', code), {
      inviteCode: code,
      leagueId: params.leagueId,
      leagueName: cleanName,
      visibility: params.visibility,
      ownerId: params.ownerUid,
      active: true,
      expiresAt: params.inviteCodeExpiresAt || null,
      createdAt: now,
      updatedAt: now,
    });

    batch.set(doc(db, 'league_members', memberDocId), {
      leagueId: params.leagueId,
      leagueOwnerId: params.ownerUid,
      userId: params.ownerUid,
      uniquePlayerId: cleanOwnerPid,
      username: cleanOwner,
      photoUrl: params.ownerPhotoUrl || null,
      role: 'OWNER',
      isReady: true,
      teamId: params.teamId,
      joinedViaCode: null,
      invitationId: null,
      joinedAt: now,
      updatedAt: now,
    });

    batch.set(doc(db, 'league_teams', memberDocId), {
      teamId: params.teamId,
      leagueId: params.leagueId,
      leagueOwnerId: params.ownerUid,
      ownerId: params.ownerUid,
      ownerName: cleanOwner,
      ownerPlayerId: cleanOwnerPid,
      teamName: params.teamName.trim().slice(0, 40),
      shortName: params.teamShortName.trim().toUpperCase().slice(0, 4),
      logoUrl: params.teamLogoUrl || null,
      primaryColor: params.primaryColor || '#D4AF37',
      totalPurse: params.startingPurse,
      remainingPurse: params.startingPurse,
      playersCount: 0,
      squadStatus: 'UNFILLED',
      createdAt: now,
      updatedAt: now,
    });

    batch.set(actRef, {
      leagueId: params.leagueId,
      leagueName: cleanName,
      leagueOwnerId: params.ownerUid,
      actorId: params.ownerUid,
      actorName: cleanOwner,
      visibility: params.visibility,
      memberIds: [params.ownerUid],
      actionType: 'LEAGUE_CREATED',
      message: `${cleanOwner} created ${cleanName} (${params.visibility}).`,
      createdAt: now,
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function lookupInviteCodeFirestore(code: string) {
  const normalized = safeInviteCode(code);
  if (!/^CV-[A-Z0-9]{4,16}$/.test(normalized)) return null;
  const path = `league_invite_codes/${normalized}`;
  try {
    const snap = await getDoc(doc(db, 'league_invite_codes', normalized));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      inviteCode: String(d.inviteCode),
      leagueId: String(d.leagueId),
      leagueName: String(d.leagueName),
      visibility: String(d.visibility) as 'PRIVATE' | 'PUBLIC',
      ownerId: String(d.ownerId),
      active: Boolean(d.active),
      expiresAt: (d.expiresAt as string | null) ?? null,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function joinLeagueTransactionFirestore(params: {
  leagueId: string;
  userUid: string;
  username: string;
  uniquePlayerId: string;
  photoUrl?: string | null;
  teamId: string;
  teamName: string;
  teamShortName: string;
  teamLogoUrl?: string | null;
  primaryColor?: string;
  joinedViaCode?: string | null;
  invitationId?: string | null;
}) {
  const path = `leagues/${params.leagueId}`;
  const leagueRef = doc(db, 'leagues', params.leagueId);
  const memberDocId = `${params.leagueId}__${params.userUid}`;
  const memberRef = doc(db, 'league_members', memberDocId);
  const teamRef = doc(db, 'league_teams', memberDocId);
  const cleanUser = safeName(params.username);
  const cleanPid = safePlayerCode(params.uniquePlayerId);

  try {
    await runTransaction(db, async (tx) => {
      const leagueSnap = await tx.get(leagueRef);
      if (!leagueSnap.exists()) return;

      const ld = leagueSnap.data();
      const memberIds: string[] = Array.isArray(ld.memberIds) ? ld.memberIds.map(String) : [];
      if (memberIds.includes(params.userUid)) return;

      const currentCount = Number(ld.participantCount || memberIds.length);
      const maxParticipants = Number(ld.maxParticipants || 12);
      if (currentCount >= maxParticipants) return;
      if (!['CREATED', 'OPEN', 'READY'].includes(String(ld.status))) return;

      const nextMemberIds = [...memberIds, params.userUid];
      const nextCount = currentCount + 1;
      const nextStatus = nextCount >= maxParticipants ? 'FULL' : String(ld.status);
      const now = serverTimestamp();

      tx.update(leagueRef, {
        participantCount: nextCount,
        memberIds: nextMemberIds,
        status: nextStatus,
        updatedAt: now,
      });

      tx.set(memberRef, {
        leagueId: params.leagueId,
        leagueOwnerId: String(ld.ownerId),
        userId: params.userUid,
        uniquePlayerId: cleanPid,
        username: cleanUser,
        photoUrl: params.photoUrl || null,
        role: 'MEMBER',
        isReady: false,
        teamId: params.teamId,
        joinedViaCode: params.joinedViaCode ? safeInviteCode(params.joinedViaCode) : null,
        invitationId: params.invitationId || null,
        joinedAt: now,
        updatedAt: now,
      });

      tx.set(teamRef, {
        teamId: params.teamId,
        leagueId: params.leagueId,
        leagueOwnerId: String(ld.ownerId),
        ownerId: params.userUid,
        ownerName: cleanUser,
        ownerPlayerId: cleanPid,
        teamName: params.teamName.trim().slice(0, 40),
        shortName: params.teamShortName.trim().toUpperCase().slice(0, 4),
        logoUrl: params.teamLogoUrl || null,
        primaryColor: params.primaryColor || '#10B981',
        totalPurse: Number(ld.startingPurse || 10000),
        remainingPurse: Number(ld.startingPurse || 10000),
        playersCount: 0,
        squadStatus: 'UNFILLED',
        createdAt: now,
        updatedAt: now,
      });

      if (params.invitationId) {
        const invRef = doc(db, 'league_invitations', params.invitationId);
        const invSnap = await tx.get(invRef);
        if (invSnap.exists() && invSnap.data().status === 'PENDING') {
          tx.update(invRef, { status: 'ACCEPTED', updatedAt: now });
        }
      }

      if (String(ld.ownerId) !== params.userUid) {
        tx.set(doc(collection(db, 'notifications')), {
          userId: String(ld.ownerId),
          senderId: params.userUid,
          type: 'LEAGUE_JOINED',
          title: `New Franchise Joined ${String(ld.name)}`,
          message: `${cleanUser} (${cleanPid}) joined with ${params.teamName.trim()}.`,
          read: false,
          metadata: { leagueId: params.leagueId, teamId: params.teamId },
          createdAt: now,
        });
      }

      tx.set(doc(collection(db, 'league_activity')), {
        leagueId: params.leagueId,
        leagueName: String(ld.name),
        leagueOwnerId: String(ld.ownerId),
        actorId: params.userUid,
        actorName: cleanUser,
        visibility: String(ld.visibility || 'PRIVATE'),
        memberIds: nextMemberIds,
        actionType: 'MEMBER_JOINED',
        message: `${cleanUser} joined ${String(ld.name)} with ${params.teamName.trim()}.`,
        createdAt: now,
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function invitePlayerFirestore(params: {
  leagueId: string;
  senderUid: string;
  senderUsername: string;
  senderPlayerId: string;
  targetUniquePlayerId: string;
}) {
  const target = await lookupPlayerByUniqueIdFirestore(params.targetUniquePlayerId);
  if (!target) return;
  if (target.uid === params.senderUid) return;

  const invId = `${params.leagueId}__${target.uid}`;
  const path = `league_invitations/${invId}`;

  try {
    const [leagueSnap, settingsSnap, existingInvSnap] = await Promise.all([
      getDoc(doc(db, 'leagues', params.leagueId)),
      getDoc(doc(db, 'league_settings', params.leagueId)),
      getDoc(doc(db, 'league_invitations', invId)),
    ]);
    if (!leagueSnap.exists()) return;
    const ld = leagueSnap.data();
    const memberIds: string[] = Array.isArray(ld.memberIds) ? ld.memberIds.map(String) : [];
    if (memberIds.includes(target.uid)) return;

    if (existingInvSnap.exists()) {
      if (existingInvSnap.data().status === 'PENDING') return;
      const cleanBatch = writeBatch(db);
      cleanBatch.delete(doc(db, 'league_invitations', invId));
      await cleanBatch.commit();
    }

    const inviteCode = settingsSnap.exists() ? String(settingsSnap.data().inviteCode || '') : null;
    const expiresAt = settingsSnap.exists() ? (settingsSnap.data().inviteCodeExpiresAt as string | null) ?? null : null;
    const senderName = safeName(params.senderUsername);
    const senderPid = safePlayerCode(params.senderPlayerId);
    const now = serverTimestamp();

    const batch = writeBatch(db);
    batch.set(doc(db, 'league_invitations', invId), {
      leagueId: params.leagueId,
      leagueName: String(ld.name),
      leagueVisibility: String(ld.visibility || 'PRIVATE'),
      leagueOwnerId: String(ld.ownerId),
      inviteCode,
      type: 'DIRECT_INVITE',
      senderId: params.senderUid,
      senderPlayerId: senderPid,
      senderUsername: senderName,
      recipientId: target.uid,
      recipientPlayerId: target.uniquePlayerId,
      recipientUsername: safeName(target.username),
      status: 'PENDING',
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    batch.set(doc(collection(db, 'notifications')), {
      userId: target.uid,
      senderId: params.senderUid,
      type: 'LEAGUE_INVITE',
      title: `League Invite: ${String(ld.name)}`,
      message: `${senderName} (${senderPid}) invited you to join ${String(ld.name)}.`,
      read: false,
      metadata: {
        leagueId: params.leagueId,
        invitationId: invId,
        ...(inviteCode ? { inviteCode } : {}),
      },
      createdAt: now,
    });

    batch.set(doc(collection(db, 'league_activity')), {
      leagueId: params.leagueId,
      leagueName: String(ld.name),
      leagueOwnerId: String(ld.ownerId),
      actorId: params.senderUid,
      actorName: senderName,
      visibility: String(ld.visibility || 'PRIVATE'),
      memberIds,
      actionType: 'INVITE_SENT',
      message: `${senderName} invited ${safeName(target.username)} (${target.uniquePlayerId}).`,
      createdAt: now,
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function requestToJoinLeagueFirestore(params: {
  leagueId: string;
  requesterUid: string;
  requesterUsername: string;
  requesterPlayerId: string;
}) {
  const invId = `${params.leagueId}__${params.requesterUid}`;
  const path = `league_invitations/${invId}`;
  try {
    const [leagueSnap, existingInvSnap] = await Promise.all([
      getDoc(doc(db, 'leagues', params.leagueId)),
      getDoc(doc(db, 'league_invitations', invId)),
    ]);
    if (!leagueSnap.exists()) return;
    const ld = leagueSnap.data();
    const memberIds: string[] = Array.isArray(ld.memberIds) ? ld.memberIds.map(String) : [];
    if (memberIds.includes(params.requesterUid)) return;

    if (existingInvSnap.exists()) {
      if (existingInvSnap.data().status === 'PENDING') return;
      const cleanBatch = writeBatch(db);
      cleanBatch.delete(doc(db, 'league_invitations', invId));
      await cleanBatch.commit();
    }

    const reqName = safeName(params.requesterUsername);
    const reqPid = safePlayerCode(params.requesterPlayerId);
    const now = serverTimestamp();

    const batch = writeBatch(db);
    batch.set(doc(db, 'league_invitations', invId), {
      leagueId: params.leagueId,
      leagueName: String(ld.name),
      leagueVisibility: String(ld.visibility || 'PRIVATE'),
      leagueOwnerId: String(ld.ownerId),
      inviteCode: null,
      type: 'JOIN_REQUEST',
      senderId: params.requesterUid,
      senderPlayerId: reqPid,
      senderUsername: reqName,
      recipientId: String(ld.ownerId),
      recipientPlayerId: safePlayerCode(String(ld.ownerPlayerId || '')),
      recipientUsername: safeName(String(ld.ownerName || 'League Owner')),
      status: 'PENDING',
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    });

    batch.set(doc(collection(db, 'notifications')), {
      userId: String(ld.ownerId),
      senderId: params.requesterUid,
      type: 'LEAGUE_REQUEST',
      title: `Join Request: ${String(ld.name)}`,
      message: `${reqName} (${reqPid}) requested to join ${String(ld.name)}.`,
      read: false,
      metadata: { leagueId: params.leagueId, invitationId: invId },
      createdAt: now,
    });

    batch.set(doc(collection(db, 'league_activity')), {
      leagueId: params.leagueId,
      leagueName: String(ld.name),
      leagueOwnerId: String(ld.ownerId),
      actorId: params.requesterUid,
      actorName: reqName,
      visibility: String(ld.visibility || 'PRIVATE'),
      memberIds,
      actionType: 'JOIN_REQUESTED',
      message: `${reqName} requested to join ${String(ld.name)}.`,
      createdAt: now,
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function respondInvitationFirestore(params: {
  invitationId: string;
  action: 'ACCEPT' | 'REJECT' | 'REVOKE';
  actorUid: string;
  teamId?: string;
  teamName?: string;
  teamShortName?: string;
  teamLogoUrl?: string | null;
  primaryColor?: string;
}) {
  const invRef = doc(db, 'league_invitations', params.invitationId);
  const path = `league_invitations/${params.invitationId}`;
  try {
    if (params.action !== 'ACCEPT') {
      const snap = await getDoc(invRef);
      if (!snap.exists() || snap.data().status !== 'PENDING') return;
      await updateDoc(invRef, {
        status: params.action === 'REJECT' ? 'REJECTED' : 'REVOKED',
        updatedAt: serverTimestamp(),
      });
      return;
    }

    await runTransaction(db, async (tx) => {
      const invSnap = await tx.get(invRef);
      if (!invSnap.exists() || invSnap.data().status !== 'PENDING') return;
      const inv = invSnap.data();
      const leagueId = String(inv.leagueId);
      const leagueRef = doc(db, 'leagues', leagueId);
      const leagueSnap = await tx.get(leagueRef);
      if (!leagueSnap.exists()) return;
      const ld = leagueSnap.data();

      const joiningUid = inv.type === 'DIRECT_INVITE' ? String(inv.recipientId) : String(inv.senderId);
      const joiningName =
        inv.type === 'DIRECT_INVITE' ? String(inv.recipientUsername) : String(inv.senderUsername);
      const joiningPid =
        inv.type === 'DIRECT_INVITE' ? String(inv.recipientPlayerId) : String(inv.senderPlayerId);

      const memberIds: string[] = Array.isArray(ld.memberIds) ? ld.memberIds.map(String) : [];
      if (memberIds.includes(joiningUid)) return;
      if (memberIds.length >= Number(ld.maxParticipants || 12)) return;

      const memberDocId = `${leagueId}__${joiningUid}`;
      const nextMemberIds = [...memberIds, joiningUid];
      const nextCount = Number(ld.participantCount || memberIds.length) + 1;
      const nextStatus = nextCount >= Number(ld.maxParticipants || 12) ? 'FULL' : String(ld.status);
      const now = serverTimestamp();

      const finalTeamName = (params.teamName || `${joiningName.split(' ')[0]} XI`).trim().slice(0, 40);
      const finalShort = (params.teamShortName || joiningName.replace(/[^A-Za-z0-9]/g, '').slice(0, 3) || 'CRK')
        .toUpperCase()
        .slice(0, 4);
      const finalTeamId = params.teamId || memberDocId;

      tx.update(invRef, { status: 'ACCEPTED', updatedAt: now });
      tx.update(leagueRef, {
        participantCount: nextCount,
        memberIds: nextMemberIds,
        status: nextStatus,
        updatedAt: now,
      });

      tx.set(doc(db, 'league_members', memberDocId), {
        leagueId,
        leagueOwnerId: String(ld.ownerId),
        userId: joiningUid,
        uniquePlayerId: safePlayerCode(joiningPid),
        username: safeName(joiningName),
        photoUrl: null,
        role: 'MEMBER',
        isReady: false,
        teamId: finalTeamId,
        joinedViaCode: null,
        invitationId: params.invitationId,
        joinedAt: now,
        updatedAt: now,
      });

      tx.set(doc(db, 'league_teams', memberDocId), {
        teamId: finalTeamId,
        leagueId,
        leagueOwnerId: String(ld.ownerId),
        ownerId: joiningUid,
        ownerName: safeName(joiningName),
        ownerPlayerId: safePlayerCode(joiningPid),
        teamName: finalTeamName,
        shortName: finalShort,
        logoUrl: params.teamLogoUrl || null,
        primaryColor: params.primaryColor || '#10B981',
        totalPurse: Number(ld.startingPurse || 10000),
        remainingPurse: Number(ld.startingPurse || 10000),
        playersCount: 0,
        squadStatus: 'UNFILLED',
        createdAt: now,
        updatedAt: now,
      });

      tx.set(doc(collection(db, 'league_activity')), {
        leagueId,
        leagueName: String(ld.name),
        leagueOwnerId: String(ld.ownerId),
        actorId: params.actorUid,
        actorName: safeName(joiningName),
        visibility: String(ld.visibility || 'PRIVATE'),
        memberIds: nextMemberIds,
        actionType: 'MEMBER_JOINED',
        message: `${safeName(joiningName)} joined ${String(ld.name)} with ${finalTeamName}.`,
        createdAt: now,
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function updateLeagueSettingsFirestore(params: {
  leagueId: string;
  actorUid: string;
  actorName: string;
  updates: {
    name?: string;
    description?: string;
    logoUrl?: string | null;
    visibility?: 'PRIVATE' | 'PUBLIC';
    maxParticipants?: number;
    numberOfTeams?: number;
    startingPurse?: number;
    squadSize?: number;
    minPlayers?: number;
    maxPlayers?: number;
    bidIncrement?: number;
    timerDuration?: number;
    auctionMode?: 'MEGA' | 'MINI' | 'FAST_TRACK';
    allowTeamCustomization?: boolean;
    minBatsmen?: number;
    minBowlers?: number;
    minAllRounders?: number;
    minWicketkeepers?: number;
    maxOverseas?: number;
  };
}) {
  const leagueRef = doc(db, 'leagues', params.leagueId);
  const settingsRef = doc(db, 'league_settings', params.leagueId);
  const path = `leagues/${params.leagueId}`;

  try {
    const [leagueSnap, settingsSnap] = await Promise.all([getDoc(leagueRef), getDoc(settingsRef)]);
    if (!leagueSnap.exists() || !settingsSnap.exists()) return;
    const ld = leagueSnap.data();
    const sd = settingsSnap.data();
    if (String(ld.ownerId) !== params.actorUid) return;

    const memberIds: string[] = Array.isArray(ld.memberIds) ? ld.memberIds.map(String) : [];
    const nextMax = params.updates.maxParticipants ?? Number(ld.maxParticipants);
    const nextPurse = params.updates.startingPurse ?? Number(ld.startingPurse);
    const nextMinPlayers = params.updates.minPlayers ?? Number(ld.minPlayers);
    const nextMaxPlayers = params.updates.maxPlayers ?? Number(ld.maxPlayers);
    const nextSquadSize = Math.min(nextMaxPlayers, Math.max(nextMinPlayers, params.updates.squadSize ?? Number(ld.squadSize)));
    const nextName = (params.updates.name || String(ld.name)).trim().slice(0, 60);
    const nextVisibility = params.updates.visibility ?? (String(ld.visibility) as 'PRIVATE' | 'PUBLIC');
    const nextStatus =
      memberIds.length >= nextMax ? 'FULL' : String(ld.status) === 'FULL' ? 'OPEN' : String(ld.status);
    const now = serverTimestamp();

    const batch = writeBatch(db);
    batch.update(leagueRef, {
      name: nextName,
      description:
        params.updates.description !== undefined
          ? params.updates.description.trim().slice(0, 300)
          : String(ld.description || ''),
      logoUrl: params.updates.logoUrl !== undefined ? params.updates.logoUrl : ld.logoUrl ?? null,
      visibility: nextVisibility,
      maxParticipants: nextMax,
      numberOfTeams: params.updates.numberOfTeams ?? nextMax,
      startingPurse: nextPurse,
      squadSize: nextSquadSize,
      minPlayers: nextMinPlayers,
      maxPlayers: nextMaxPlayers,
      bidIncrement: params.updates.bidIncrement ?? Number(ld.bidIncrement),
      timerDuration: params.updates.timerDuration ?? Number(ld.timerDuration),
      auctionMode: params.updates.auctionMode ?? String(ld.auctionMode),
      status: nextStatus,
      updatedAt: now,
    });

    batch.update(settingsRef, {
      startingPurse: nextPurse,
      squadSize: nextSquadSize,
      minPlayers: nextMinPlayers,
      maxPlayers: nextMaxPlayers,
      bidIncrement: params.updates.bidIncrement ?? Number(sd.bidIncrement),
      timerDuration: params.updates.timerDuration ?? Number(sd.timerDuration),
      auctionMode: params.updates.auctionMode ?? String(sd.auctionMode),
      allowTeamCustomization:
        params.updates.allowTeamCustomization ?? Boolean(sd.allowTeamCustomization ?? true),
      minBatsmen: params.updates.minBatsmen ?? Number(sd.minBatsmen ?? 4),
      minBowlers: params.updates.minBowlers ?? Number(sd.minBowlers ?? 4),
      minAllRounders: params.updates.minAllRounders ?? Number(sd.minAllRounders ?? 2),
      minWicketkeepers: params.updates.minWicketkeepers ?? Number(sd.minWicketkeepers ?? 1),
      maxOverseas: params.updates.maxOverseas ?? Number(sd.maxOverseas ?? 8),
      updatedAt: now,
    });

    batch.set(
      doc(db, 'squad_settings', params.leagueId),
      {
        leagueId: params.leagueId,
        ownerId: params.actorUid,
        minSquadSize: nextMinPlayers,
        maxSquadSize: nextMaxPlayers,
        maxOverseas: params.updates.maxOverseas ?? Number(sd.maxOverseas ?? 8),
        minWicketkeepers: params.updates.minWicketkeepers ?? Number(sd.minWicketkeepers ?? 1),
        minBatsmen: params.updates.minBatsmen ?? Number(sd.minBatsmen ?? 4),
        minBowlers: params.updates.minBowlers ?? Number(sd.minBowlers ?? 4),
        minAllRounders: params.updates.minAllRounders ?? Number(sd.minAllRounders ?? 2),
        updatedAt: now,
      },
      { merge: true }
    );

    const inviteCode = String(sd.inviteCode || '');
    if (inviteCode) {
      batch.update(doc(db, 'league_invite_codes', inviteCode), {
        leagueName: nextName,
        visibility: nextVisibility,
        updatedAt: now,
      });
    }

    if (nextPurse !== Number(ld.startingPurse)) {
      for (const mUid of memberIds) {
        batch.update(doc(db, 'league_teams', `${params.leagueId}__${mUid}`), {
          totalPurse: nextPurse,
          remainingPurse: nextPurse,
          updatedAt: now,
        });
      }
    }

    batch.set(doc(collection(db, 'league_activity')), {
      leagueId: params.leagueId,
      leagueName: nextName,
      leagueOwnerId: String(ld.ownerId),
      actorId: params.actorUid,
      actorName: safeName(params.actorName),
      visibility: nextVisibility,
      memberIds,
      actionType: 'SETTINGS_UPDATED',
      message: `${safeName(params.actorName)} updated league settings.`,
      createdAt: now,
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function customizeMyTeamFirestore(params: {
  leagueId: string;
  userUid: string;
  actorName: string;
  teamName: string;
  shortName: string;
  logoUrl?: string | null;
  primaryColor?: string;
}) {
  const teamDocId = `${params.leagueId}__${params.userUid}`;
  const path = `league_teams/${teamDocId}`;
  try {
    const [leagueSnap, teamSnap] = await Promise.all([
      getDoc(doc(db, 'leagues', params.leagueId)),
      getDoc(doc(db, 'league_teams', teamDocId)),
    ]);
    if (!leagueSnap.exists() || !teamSnap.exists()) return;
    const ld = leagueSnap.data();
    const memberIds: string[] = Array.isArray(ld.memberIds) ? ld.memberIds.map(String) : [];
    const now = serverTimestamp();

    const batch = writeBatch(db);
    batch.update(doc(db, 'league_teams', teamDocId), {
      teamName: params.teamName.trim().slice(0, 40),
      shortName: params.shortName.trim().toUpperCase().slice(0, 4),
      logoUrl: params.logoUrl !== undefined ? params.logoUrl : teamSnap.data().logoUrl ?? null,
      primaryColor: params.primaryColor || String(teamSnap.data().primaryColor || '#D4AF37'),
      updatedAt: now,
    });

    batch.set(doc(collection(db, 'league_activity')), {
      leagueId: params.leagueId,
      leagueName: String(ld.name),
      leagueOwnerId: String(ld.ownerId),
      actorId: params.userUid,
      actorName: safeName(params.actorName),
      visibility: String(ld.visibility || 'PRIVATE'),
      memberIds,
      actionType: 'TEAM_CUSTOMIZED',
      message: `${safeName(params.actorName)} customized their franchise to ${params.teamName.trim()}.`,
      createdAt: now,
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function toggleMemberReadyFirestore(leagueId: string, userUid: string, isReady: boolean) {
  const path = `league_members/${leagueId}__${userUid}`;
  try {
    const ref = doc(db, 'league_members', `${leagueId}__${userUid}`);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    await updateDoc(ref, { isReady, updatedAt: serverTimestamp() });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function removeOrLeaveMemberFirestore(params: {
  leagueId: string;
  targetUid: string;
  actorUid: string;
  actorName: string;
  isSelfLeave: boolean;
}) {
  const leagueRef = doc(db, 'leagues', params.leagueId);
  const docId = `${params.leagueId}__${params.targetUid}`;
  const path = `leagues/${params.leagueId}`;

  try {
    await runTransaction(db, async (tx) => {
      const leagueSnap = await tx.get(leagueRef);
      if (!leagueSnap.exists()) return;
      const ld = leagueSnap.data();
      const memberIds: string[] = Array.isArray(ld.memberIds) ? ld.memberIds.map(String) : [];
      if (!memberIds.includes(params.targetUid)) return;
      if (String(ld.ownerId) === params.targetUid) return;

      const nextMembers = memberIds.filter((id) => id !== params.targetUid);
      const nextCount = Math.max(1, Number(ld.participantCount || memberIds.length) - 1);
      const nextStatus =
        String(ld.status) === 'FULL' || (String(ld.status) === 'READY' && nextCount < 2)
          ? 'OPEN'
          : String(ld.status);
      const now = serverTimestamp();

      tx.update(leagueRef, {
        participantCount: nextCount,
        memberIds: nextMembers,
        status: nextStatus,
        updatedAt: now,
      });
      tx.delete(doc(db, 'league_members', docId));
      tx.delete(doc(db, 'league_teams', docId));
      tx.set(doc(collection(db, 'league_activity')), {
        leagueId: params.leagueId,
        leagueName: String(ld.name),
        leagueOwnerId: String(ld.ownerId),
        actorId: params.actorUid,
        actorName: safeName(params.actorName),
        visibility: String(ld.visibility || 'PRIVATE'),
        memberIds: nextMembers,
        actionType: params.isSelfLeave ? 'MEMBER_LEFT' : 'MEMBER_REMOVED',
        message: params.isSelfLeave
          ? `${safeName(params.actorName)} left ${String(ld.name)}.`
          : `${safeName(params.actorName)} removed a member from ${String(ld.name)}.`,
        createdAt: now,
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function transferOwnershipFirestore(params: {
  leagueId: string;
  currentOwnerUid: string;
  currentOwnerName: string;
  newOwnerUid: string;
  newOwnerName: string;
  newOwnerPlayerId: string;
}) {
  const leagueRef = doc(db, 'leagues', params.leagueId);
  const settingsRef = doc(db, 'league_settings', params.leagueId);
  const path = `leagues/${params.leagueId}`;

  try {
    await runTransaction(db, async (tx) => {
      const [leagueSnap, settingsSnap] = await Promise.all([tx.get(leagueRef), tx.get(settingsRef)]);
      if (!leagueSnap.exists() || !settingsSnap.exists()) return;
      const ld = leagueSnap.data();
      const sd = settingsSnap.data();
      if (String(ld.ownerId) !== params.currentOwnerUid) return;

      const memberIds: string[] = Array.isArray(ld.memberIds) ? ld.memberIds.map(String) : [];
      if (!memberIds.includes(params.newOwnerUid)) return;
      const now = serverTimestamp();

      tx.update(leagueRef, {
        ownerId: params.newOwnerUid,
        ownerName: safeName(params.newOwnerName),
        ownerPlayerId: safePlayerCode(params.newOwnerPlayerId),
        updatedAt: now,
      });

      tx.update(settingsRef, {
        ownerId: params.newOwnerUid,
        updatedAt: now,
      });

      const inviteCode = String(sd.inviteCode || '');
      if (inviteCode) {
        tx.update(doc(db, 'league_invite_codes', inviteCode), {
          ownerId: params.newOwnerUid,
          updatedAt: now,
        });
      }

      for (const mUid of memberIds) {
        const mDocId = `${params.leagueId}__${mUid}`;
        if (mUid === params.currentOwnerUid) {
          tx.update(doc(db, 'league_members', mDocId), {
            role: 'MEMBER',
            leagueOwnerId: params.newOwnerUid,
            updatedAt: now,
          });
        } else if (mUid === params.newOwnerUid) {
          tx.update(doc(db, 'league_members', mDocId), {
            role: 'OWNER',
            leagueOwnerId: params.newOwnerUid,
            isReady: true,
            updatedAt: now,
          });
        } else {
          tx.update(doc(db, 'league_members', mDocId), {
            leagueOwnerId: params.newOwnerUid,
            updatedAt: now,
          });
        }
        tx.update(doc(db, 'league_teams', mDocId), {
          leagueOwnerId: params.newOwnerUid,
          updatedAt: now,
        });
      }

      tx.set(doc(collection(db, 'notifications')), {
        userId: params.newOwnerUid,
        senderId: params.currentOwnerUid,
        type: 'LEAGUE_UPDATE',
        title: `Ownership Transferred: ${String(ld.name)}`,
        message: `${safeName(params.currentOwnerName)} transferred ownership of ${String(ld.name)} to you.`,
        read: false,
        metadata: { leagueId: params.leagueId },
        createdAt: now,
      });

      tx.set(doc(collection(db, 'league_activity')), {
        leagueId: params.leagueId,
        leagueName: String(ld.name),
        leagueOwnerId: params.newOwnerUid,
        actorId: params.currentOwnerUid,
        actorName: safeName(params.currentOwnerName),
        visibility: String(ld.visibility || 'PRIVATE'),
        memberIds,
        actionType: 'OWNERSHIP_TRANSFERRED',
        message: `Ownership transferred to ${safeName(params.newOwnerName)}.`,
        createdAt: now,
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function updateLeagueStatusFirestore(params: {
  leagueId: string;
  actorUid: string;
  actorName: string;
  nextStatus: 'OPEN' | 'FULL' | 'READY' | 'AUCTION_IN_PROGRESS' | 'CANCELLED';
  actionType: 'LEAGUE_READY' | 'AUCTION_STARTED' | 'LEAGUE_CANCELLED';
  message: string;
}) {
  const leagueRef = doc(db, 'leagues', params.leagueId);
  const settingsRef = doc(db, 'league_settings', params.leagueId);
  const path = `leagues/${params.leagueId}`;

  try {
    const [leagueSnap, settingsSnap] = await Promise.all([getDoc(leagueRef), getDoc(settingsRef)]);
    if (!leagueSnap.exists()) return;
    const ld = leagueSnap.data();
    const memberIds: string[] = Array.isArray(ld.memberIds) ? ld.memberIds.map(String) : [];
    const now = serverTimestamp();

    const batch = writeBatch(db);
    batch.update(leagueRef, { status: params.nextStatus, updatedAt: now });

    if (params.nextStatus === 'CANCELLED' && settingsSnap.exists()) {
      const code = String(settingsSnap.data().inviteCode || '');
      batch.update(settingsRef, { inviteCodeActive: false, updatedAt: now });
      if (code) {
        batch.update(doc(db, 'league_invite_codes', code), { active: false, updatedAt: now });
      }
    }

    batch.set(doc(collection(db, 'league_activity')), {
      leagueId: params.leagueId,
      leagueName: String(ld.name),
      leagueOwnerId: String(ld.ownerId),
      actorId: params.actorUid,
      actorName: safeName(params.actorName),
      visibility: String(ld.visibility || 'PRIVATE'),
      memberIds,
      actionType: params.actionType,
      message: params.message.slice(0, 260),
      createdAt: now,
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function syncInviteCodeChangeFirestore(params: {
  leagueId: string;
  actorUid: string;
  actorName: string;
  oldCode: string;
  newCode: string;
  active: boolean;
  expiresAt?: string | null;
}) {
  const path = `league_settings/${params.leagueId}`;
  try {
    const leagueSnap = await getDoc(doc(db, 'leagues', params.leagueId));
    if (!leagueSnap.exists()) return;
    const ld = leagueSnap.data();
    const memberIds: string[] = Array.isArray(ld.memberIds) ? ld.memberIds.map(String) : [];
    const now = serverTimestamp();
    const cleanOld = safeInviteCode(params.oldCode);
    const cleanNew = safeInviteCode(params.newCode);

    const batch = writeBatch(db);
    batch.update(doc(db, 'league_settings', params.leagueId), {
      inviteCode: cleanNew,
      inviteCodeActive: params.active,
      inviteCodeExpiresAt: params.expiresAt || null,
      updatedAt: now,
    });

    if (cleanOld && cleanOld !== cleanNew) {
      batch.update(doc(db, 'league_invite_codes', cleanOld), {
        active: false,
        updatedAt: now,
      });
    }

    if (cleanOld === cleanNew) {
      batch.update(doc(db, 'league_invite_codes', cleanNew), {
        active: params.active,
        expiresAt: params.expiresAt || null,
        updatedAt: now,
      });
    } else {
      batch.set(doc(db, 'league_invite_codes', cleanNew), {
        inviteCode: cleanNew,
        leagueId: params.leagueId,
        leagueName: String(ld.name),
        visibility: String(ld.visibility || 'PRIVATE'),
        ownerId: String(ld.ownerId),
        active: params.active,
        expiresAt: params.expiresAt || null,
        createdAt: now,
        updatedAt: now,
      });
    }

    batch.set(doc(collection(db, 'league_activity')), {
      leagueId: params.leagueId,
      leagueName: String(ld.name),
      leagueOwnerId: String(ld.ownerId),
      actorId: params.actorUid,
      actorName: safeName(params.actorName),
      visibility: String(ld.visibility || 'PRIVATE'),
      memberIds,
      actionType: 'CODE_REGENERATED',
      message: params.active
        ? `${safeName(params.actorName)} generated a new invitation code.`
        : `${safeName(params.actorName)} revoked the invitation code.`,
      createdAt: now,
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

// --- Real-Time onSnapshot Subscriptions ---

function mapLeagueDoc(d: Record<string, unknown>, id: string): FsLeague {
  return {
    leagueId: String(d.leagueId || id),
    name: String(d.name || ''),
    description: String(d.description || ''),
    logoUrl: (d.logoUrl as string | null) ?? null,
    visibility: (d.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE'),
    ownerId: String(d.ownerId || ''),
    ownerName: String(d.ownerName || 'League Owner'),
    ownerPlayerId: String(d.ownerPlayerId || ''),
    status: String(d.status || 'OPEN') as FsLeague['status'],
    maxParticipants: Number(d.maxParticipants || 8),
    numberOfTeams: Number(d.numberOfTeams || d.maxParticipants || 8),
    participantCount: Number(d.participantCount || 1),
    memberIds: Array.isArray(d.memberIds) ? d.memberIds.map(String) : [],
    startingPurse: Number(d.startingPurse || 10000),
    squadSize: Number(d.squadSize || 18),
    minPlayers: Number(d.minPlayers || 11),
    maxPlayers: Number(d.maxPlayers || 18),
    bidIncrement: Number(d.bidIncrement || 25),
    timerDuration: Number(d.timerDuration || 15),
    auctionMode: (d.auctionMode || 'MEGA') as FsLeague['auctionMode'],
    createdAt: toIso(d.createdAt),
    updatedAt: toIso(d.updatedAt),
  };
}

export function subscribeToMyLeaguesFirestore(uid: string, onData: (leagues: FsLeague[]) => void) {
  const path = 'leagues';
  const q = query(collection(db, path), where('memberIds', 'array-contains', uid));
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs
        .map((docSnap) => mapLeagueDoc(docSnap.data(), docSnap.id))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onData(list);
    },
    (error) => {
      reportFirestoreListenerError(error, OperationType.LIST, path);
    }
  );
}

export function subscribeToPublicLeaguesFirestore(onData: (leagues: FsLeague[]) => void) {
  const path = 'leagues';
  const q = query(collection(db, path), where('visibility', '==', 'PUBLIC'));
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs
        .map((docSnap) => mapLeagueDoc(docSnap.data(), docSnap.id))
        .filter((l) => l.status !== 'CANCELLED')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onData(list);
    },
    (error) => {
      reportFirestoreListenerError(error, OperationType.LIST, path);
    }
  );
}

export function subscribeToLeagueInvitationsFirestore(
  uid: string,
  onData: (invitations: FsLeagueInvitation[]) => void
) {
  const path = 'league_invitations';
  const bucket = new Map<string, FsLeagueInvitation>();

  const emit = () => {
    const list = Array.from(bucket.values())
      .filter((i) => i.status === 'PENDING')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    onData(list);
  };

  const mapInv = (docId: string, d: Record<string, unknown>): FsLeagueInvitation => ({
    id: docId,
    leagueId: String(d.leagueId),
    leagueName: String(d.leagueName || 'League'),
    leagueVisibility: d.leagueVisibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
    leagueOwnerId: String(d.leagueOwnerId || ''),
    inviteCode: (d.inviteCode as string | null) ?? null,
    type: d.type === 'JOIN_REQUEST' ? 'JOIN_REQUEST' : 'DIRECT_INVITE',
    senderId: String(d.senderId || ''),
    senderPlayerId: String(d.senderPlayerId || ''),
    senderUsername: String(d.senderUsername || ''),
    recipientId: String(d.recipientId || ''),
    recipientPlayerId: String(d.recipientPlayerId || ''),
    recipientUsername: String(d.recipientUsername || ''),
    status: String(d.status || 'PENDING') as FsLeagueInvitation['status'],
    expiresAt: (d.expiresAt as string | null) ?? null,
    createdAt: toIso(d.createdAt),
  });

  const qRec = query(collection(db, path), where('recipientId', '==', uid));
  const qSend = query(collection(db, path), where('senderId', '==', uid));

  const unsub1 = onSnapshot(
    qRec,
    (snap) => {
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') bucket.delete(ch.doc.id);
        else bucket.set(ch.doc.id, mapInv(ch.doc.id, ch.doc.data()));
      }
      emit();
    },
    (error) => {
      reportFirestoreListenerError(error, OperationType.LIST, path);
    }
  );

  const unsub2 = onSnapshot(
    qSend,
    (snap) => {
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') bucket.delete(ch.doc.id);
        else bucket.set(ch.doc.id, mapInv(ch.doc.id, ch.doc.data()));
      }
      emit();
    },
    (error) => {
      reportFirestoreListenerError(error, OperationType.LIST, path);
    }
  );

  return () => {
    unsub1();
    unsub2();
  };
}

export function subscribeToLeagueActivityFirestore(
  uid: string,
  onData: (items: FsLeagueActivity[]) => void
) {
  const path = 'league_activity';
  const q = query(collection(db, path), where('memberIds', 'array-contains', uid));
  return onSnapshot(
    q,
    (snap) => {
      const items = snap.docs
        .map((docSnap) => {
          const d = docSnap.data();
          return {
            id: docSnap.id,
            leagueId: String(d.leagueId || ''),
            leagueName: String(d.leagueName || 'League'),
            actorId: String(d.actorId || ''),
            actorName: String(d.actorName || 'Member'),
            actionType: String(d.actionType || 'UPDATE'),
            message: String(d.message || ''),
            createdAt: toIso(d.createdAt),
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 25);
      onData(items);
    },
    (error) => {
      reportFirestoreListenerError(error, OperationType.LIST, path);
    }
  );
}

export function subscribeToLeagueLobbyDocsFirestore(
  leagueId: string,
  onUpdate: () => void
) {
  const unsubLeague = onSnapshot(
    doc(db, 'leagues', leagueId),
    () => onUpdate(),
    (error) => {
      // Ignore permission errors if user has not joined a private league yet
      if (!String(error).includes('permission')) {
        reportFirestoreListenerError(error, OperationType.GET, `leagues/${leagueId}`);
      }
    }
  );
  return unsubLeague;
}
