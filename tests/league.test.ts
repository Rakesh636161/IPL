import assert from 'node:assert/strict';
import test from 'node:test';
import dotenv from 'dotenv';
import { eq, inArray } from 'drizzle-orm';

dotenv.config();

import { db, pool } from '../src/db/index.ts';
import { ensurePlayersSeeded } from '../src/db/seedPlayers.ts';
import { auditLogs, leagues, notifications, users } from '../src/db/schema.ts';
import { DbUserRecord, getOrCreateDbUser } from '../server/middleware/auth.ts';
import {
  cancelLeague,
  createLeague,
  customizeMyTeam,
  getLeagueDetails,
  inviteFriendToLeague,
  joinLeagueByCode,
  joinPublicLeagueById,
  leaveLeague,
  listUserLeagues,
  markLeagueReady,
  regenerateInviteCode,
  removeMemberFromLeague,
  requestToJoinLeague,
  respondToLeagueInvitation,
  revokeInviteCode,
  toggleReadyStatus,
  transferLeagueOwnership,
  updateLeagueSettings,
  validateInviteCodePreview,
} from '../server/services/leagueService.ts';
import { clearAuctionTimers, startAuction, stopAuctionTicker } from '../server/services/auctionEngine.ts';

const testUserIds: string[] = [];
const testLeagueIds: string[] = [];

test.after(async () => {
  stopAuctionTicker();
  if (testLeagueIds.length > 0) {
    for (const lid of testLeagueIds) clearAuctionTimers(lid);
    await db.delete(leagues).where(inArray(leagues.id, testLeagueIds));
  }
  if (testUserIds.length > 0) {
    await db.delete(notifications).where(inArray(notifications.userId, testUserIds));
    await db.delete(auditLogs).where(inArray(auditLogs.actorUserId, testUserIds));
    await db.delete(users).where(inArray(users.id, testUserIds));
  }
  await pool.end();
});

test('Prompt 3 Suite: League Creation, Invitations, Join Guards, Teams, Ownership, Status Lifecycle & Persistence', async () => {
  await ensurePlayersSeeded();
  const suffix = Date.now().toString(36);

  // Create 4 test users with sequential CV100001+ IDs
  const usersList: DbUserRecord[] = [];
  for (let i = 0; i < 4; i++) {
    const u = await getOrCreateDbUser(
      `league-test-uid-${suffix}-${i}`,
      `ltest${i}-${suffix}@cricketverse.test`,
      `Franchise Manager ${i}`
    );
    testUserIds.push(u.id);
    usersList.push(u);
  }
  const [owner, playerB, playerC, playerD] = usersList;

  // 1. Create a Private League (maxTeams = 2) & Public League
  const createdPriv = await createLeague(owner.id, {
    name: `Private Champions ${suffix}`,
    description: 'High stakes private auction',
    visibility: 'PRIVATE',
    maxTeams: 2,
    numberOfTeams: 2,
    purseAmount: 12000,
    minSquadSize: 11,
    maxSquadSize: 18,
    bidIncrement: 25,
    timerSeconds: 15,
    auctionMode: 'MEGA',
    teamName: 'Owner Royals',
    teamShortName: 'OWR',
    inviteCodeExpiresInHours: 48,
    settings: { allowTeamCustomization: true },
  });
  testLeagueIds.push(createdPriv.league.id);

  assert.equal(createdPriv.league.ownerId, owner.id);
  assert.equal(createdPriv.league.status, 'OPEN');
  assert.match(createdPriv.league.inviteCode, /^CV-[A-F0-9]{6}$/);
  assert.equal(createdPriv.team.remainingPurse, 12000);

  const createdPub = await createLeague(owner.id, {
    name: `Public Premier ${suffix}`,
    description: 'Open public tournament',
    visibility: 'PUBLIC',
    maxTeams: 4,
    numberOfTeams: 4,
    purseAmount: 10000,
    minSquadSize: 11,
    maxSquadSize: 18,
    bidIncrement: 25,
    timerSeconds: 15,
    auctionMode: 'MINI',
    teamName: 'Public Kings',
    teamShortName: 'PBK',
  });
  testLeagueIds.push(createdPub.league.id);
  assert.notEqual(createdPriv.league.inviteCode, createdPub.league.inviteCode);

  // 2. Reject invalid invite code
  await assert.rejects(() => validateInviteCodePreview(playerB.id, 'CV-BAD999'), /LEAGUE_NOT_FOUND/);
  await assert.rejects(
    () => joinLeagueByCode(playerB.id, 'CV-BAD999', 'Bad XI', 'BAD'),
    /LEAGUE_NOT_FOUND/
  );

  // 3. Validate code preview & Invite Player B by CricketVerse Player ID
  const preview = await validateInviteCodePreview(playerB.id, createdPriv.league.inviteCode);
  assert.equal(preview.league.id, createdPriv.league.id);
  assert.equal(preview.joinable, true);

  // Prevent self-invite
  await assert.rejects(
    () => inviteFriendToLeague(owner.id, createdPriv.league.id, { uniquePlayerId: owner.profile!.uniquePlayerId }),
    /CANNOT_INVITE_SELF/
  );

  const inviteB = await inviteFriendToLeague(owner.id, createdPriv.league.id, {
    uniquePlayerId: playerB.profile!.uniquePlayerId,
  });
  assert.equal(inviteB.invitation.status, 'PENDING');

  // Prevent duplicate pending invite
  await assert.rejects(
    () =>
      inviteFriendToLeague(owner.id, createdPriv.league.id, {
        uniquePlayerId: playerB.profile!.uniquePlayerId,
      }),
    /INVITE_ALREADY_PENDING/
  );

  // 4. Reject invite, re-invite, then Accept -> League transitions OPEN -> FULL (2/2)
  await respondToLeagueInvitation(playerB.id, inviteB.invitation.id, 'REJECT');
  const inviteB2 = await inviteFriendToLeague(owner.id, createdPriv.league.id, {
    uniquePlayerId: playerB.profile!.uniquePlayerId,
  });
  const acceptRes = await respondToLeagueInvitation(
    playerB.id,
    inviteB2.invitation.id,
    'ACCEPT',
    'Beta Titans',
    'BTT'
  );
  assert.equal(acceptRes.invitation.status, 'ACCEPTED');
  assert.equal(acceptRes.league.status, 'FULL');

  // Owner should receive a notification on join
  const ownerNotifs = await db.select().from(notifications).where(eq(notifications.userId, owner.id));
  assert.ok(ownerNotifs.some((n) => n.type === 'LEAGUE_JOINED'));

  // 5. Prevent duplicate membership & prevent joining FULL league
  await assert.rejects(
    () => joinLeagueByCode(playerB.id, createdPriv.league.inviteCode, 'Dup XI', 'DUP'),
    /ALREADY_MEMBER/
  );
  await assert.rejects(
    () => joinLeagueByCode(playerC.id, createdPriv.league.inviteCode, 'Third XI', 'THD'),
    /LEAGUE_FULL/
  );

  // 6. Unauthorized non-owner cannot edit settings, remove members, or cancel league
  await assert.rejects(
    () => updateLeagueSettings(playerB.id, createdPriv.league.id, { name: 'Hacked Name' }),
    /FORBIDDEN_OWNER_ONLY/
  );
  await assert.rejects(
    () => removeMemberFromLeague(playerB.id, createdPriv.league.id, owner.id),
    /FORBIDDEN_OWNER_ONLY/
  );
  await assert.rejects(() => cancelLeague(playerB.id, createdPriv.league.id), /FORBIDDEN_OWNER_ONLY/);

  // 7. Member team customization pre-auction + toggling ready status
  const customizedB = await customizeMyTeam(playerB.id, createdPriv.league.id, {
    teamName: 'Beta Blazers',
    shortName: 'BBL',
    primaryColor: '#3B82F6',
  });
  assert.equal(customizedB.name, 'Beta Blazers');
  assert.equal(customizedB.shortName, 'BBL');

  const readyB = await toggleReadyStatus(playerB.id, createdPriv.league.id, true);
  assert.equal(readyB.isReady, true);

  // Disable customization via owner settings -> member edit blocked, owner edit allowed
  await updateLeagueSettings(owner.id, createdPriv.league.id, {
    maxTeams: 4,
    numberOfTeams: 4,
    allowTeamCustomization: false,
    purseAmount: 15000,
  });
  await assert.rejects(
    () =>
      customizeMyTeam(playerB.id, createdPriv.league.id, {
        teamName: 'Blocked Change',
        shortName: 'BLK',
      }),
    /TEAM_CUSTOMIZATION_DISABLED/
  );

  // 8. Private Join Request approval + Public League join + Invite revocation
  const joinReqC = await requestToJoinLeague(playerC.id, createdPriv.league.id);
  const approvedC = await respondToLeagueInvitation(
    owner.id,
    joinReqC.invitation.id,
    'ACCEPT',
    'Gamma Strikers',
    'GMS'
  );
  assert.ok('team' in approvedC && approvedC.team);
  assert.equal(approvedC.team.name, 'Gamma Strikers');

  const pubJoinedB = await joinPublicLeagueById(playerB.id, createdPub.league.id, 'Pub Beta', 'PBB');
  assert.equal(pubJoinedB.team.name, 'Pub Beta');

  // Revoke invite code & verify old code rejected; regenerate & verify new code works
  const oldCode = createdPriv.league.inviteCode;
  await revokeInviteCode(owner.id, createdPriv.league.id);
  await assert.rejects(
    () => joinLeagueByCode(playerD.id, oldCode, 'Delta XI', 'DLT'),
    /INVITE_REVOKED/
  );
  const regen = await regenerateInviteCode(owner.id, createdPriv.league.id, 24);
  assert.notEqual(regen.inviteCode, oldCode);

  const invD = await inviteFriendToLeague(owner.id, createdPriv.league.id, {
    uniquePlayerId: playerD.profile!.uniquePlayerId,
  });
  await respondToLeagueInvitation(owner.id, invD.invitation.id, 'REVOKE');
  await assert.rejects(
    () => respondToLeagueInvitation(playerD.id, invD.invitation.id, 'ACCEPT'),
    /INVITATION_NOT_PENDING/
  );

  // 9. Remove member & Leave league + Owner transfer
  await removeMemberFromLeague(owner.id, createdPriv.league.id, playerC.id);
  await leaveLeague(playerB.id, createdPub.league.id);

  // Transfer ownership of Private League to Player B, then transfer back or mark READY
  await transferLeagueOwnership(owner.id, createdPriv.league.id, playerB.id);
  let privDetails = await getLeagueDetails(createdPriv.league.id, playerB.id);
  assert.equal(privDetails?.league.ownerId, playerB.id);

  // Previous owner can now leave, or new owner can mark READY & start auction
  const readyLeague = await markLeagueReady(playerB.id, createdPriv.league.id, true);
  assert.equal(readyLeague.status, 'READY');

  // Start auction on Private League -> status transitions to AUCTION_IN_PROGRESS
  await startAuction(createdPriv.league.id, playerB.id);
  clearAuctionTimers(createdPriv.league.id);
  privDetails = await getLeagueDetails(createdPriv.league.id, playerB.id);
  assert.equal(privDetails?.league.status, 'AUCTION_IN_PROGRESS');

  // Cannot join or edit settings after auction starts
  await assert.rejects(
    () => joinLeagueByCode(playerD.id, regen.inviteCode, 'Late XI', 'LTE'),
    /LEAGUE_ALREADY_STARTED/
  );
  await assert.rejects(
    () => updateLeagueSettings(playerB.id, createdPriv.league.id, { name: 'Too Late' }),
    /CANNOT_EDIT_AFTER_AUCTION_START/
  );

  // 10. Cancel Public League -> blocks joining & starting auction
  const cancelledPub = await cancelLeague(owner.id, createdPub.league.id);
  assert.equal(cancelledPub.status, 'CANCELLED');
  await assert.rejects(
    () => joinPublicLeagueById(playerD.id, createdPub.league.id, 'Cancel XI', 'CNC'),
    /LEAGUE_CANCELLED/
  );
  await assert.rejects(() => startAuction(createdPub.league.id, owner.id), /LEAGUE_CANCELLED/);

  // 11. Persistence reload check
  const userLeaguesView = await listUserLeagues(playerB.id);
  assert.ok(userLeaguesView.myLeagues.some((l) => l.id === createdPriv.league.id));
  assert.ok(userLeaguesView.recentActivity.length > 0);
});
