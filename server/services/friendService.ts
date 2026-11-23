import { and, eq, ilike, ne, or } from 'drizzle-orm';
import { db } from '../../src/db/index.ts';
import { friends, notifications, userProfiles, users } from '../../src/db/schema.ts';

export async function searchUsersByPlayerId(currentUserId: string, queryText: string) {
  const clean = queryText.trim();
  if (!clean) return [];

  try {
    const rows = await db
      .select({
        userId: userProfiles.userId,
        uniquePlayerId: userProfiles.uniquePlayerId,
        displayName: userProfiles.displayName,
        avatarUrl: userProfiles.avatarUrl,
        country: userProfiles.country,
        onlineStatus: userProfiles.onlineStatus,
      })
      .from(userProfiles)
      .where(
        and(
          ne(userProfiles.userId, currentUserId),
          or(
            ilike(userProfiles.uniquePlayerId, `%${clean}%`),
            ilike(userProfiles.displayName, `%${clean}%`)
          )
        )
      )
      .limit(15);
    return rows;
  } catch (error) {
    throw new Error('Failed to search users.', { cause: error });
  }
}

export async function sendFriendRequest(requesterId: string, targetUniquePlayerId: string) {
  try {
    const [targetProfile] = await db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.uniquePlayerId, targetUniquePlayerId.trim().toUpperCase()))
      .limit(1);

    if (!targetProfile) {
      throw new Error('PLAYER_NOT_FOUND');
    }
    if (targetProfile.userId === requesterId) {
      throw new Error('CANNOT_ADD_SELF');
    }

    const existing = await db
      .select()
      .from(friends)
      .where(
        or(
          and(eq(friends.requesterId, requesterId), eq(friends.addresseeId, targetProfile.userId)),
          and(eq(friends.requesterId, targetProfile.userId), eq(friends.addresseeId, requesterId))
        )
      )
      .limit(1);

    let resultRow;
    if (existing[0]) {
      if (existing[0].status === 'ACCEPTED') throw new Error('ALREADY_FRIENDS');
      if (existing[0].status === 'PENDING') throw new Error('REQUEST_PENDING');
      const [reopened] = await db
        .update(friends)
        .set({ requesterId, addresseeId: targetProfile.userId, status: 'PENDING', updatedAt: new Date() })
        .where(eq(friends.id, existing[0].id))
        .returning();
      resultRow = reopened;
    } else {
      const [created] = await db
        .insert(friends)
        .values({
          requesterId,
          addresseeId: targetProfile.userId,
          status: 'PENDING',
        })
        .returning();
      resultRow = created;
    }

    const [senderProfile] = await db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, requesterId))
      .limit(1);

    await db.insert(notifications).values({
      userId: targetProfile.userId,
      type: 'FRIEND_REQUEST',
      title: 'New Friend Request',
      message: `${senderProfile?.displayName || 'A player'} (${senderProfile?.uniquePlayerId || ''}) sent you a friend request.`,
      metadata: { friendshipId: resultRow.id, requesterId },
    });

    return resultRow;
  } catch (error) {
    if (
      error instanceof Error &&
      ['PLAYER_NOT_FOUND', 'CANNOT_ADD_SELF', 'ALREADY_FRIENDS', 'REQUEST_PENDING'].includes(error.message)
    ) {
      throw error;
    }
    throw new Error('Failed to send friend request.', { cause: error });
  }
}

export async function respondToFriendRequest(
  userId: string,
  friendshipId: string,
  action: 'ACCEPT' | 'REJECT'
) {
  try {
    const [row] = await db
      .select()
      .from(friends)
      .where(and(eq(friends.id, friendshipId), eq(friends.addresseeId, userId)))
      .limit(1);

    if (!row) throw new Error('REQUEST_NOT_FOUND');

    const [updated] = await db
      .update(friends)
      .set({
        status: action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
        updatedAt: new Date(),
      })
      .where(eq(friends.id, friendshipId))
      .returning();

    return updated;
  } catch (error) {
    if (error instanceof Error && error.message === 'REQUEST_NOT_FOUND') throw error;
    throw new Error('Failed to respond to friend request.', { cause: error });
  }
}

export async function removeFriend(userId: string, friendshipId: string) {
  try {
    const deleted = await db
      .delete(friends)
      .where(
        and(
          eq(friends.id, friendshipId),
          or(eq(friends.requesterId, userId), eq(friends.addresseeId, userId))
        )
      )
      .returning();
    if (!deleted.length) throw new Error('FRIENDSHIP_NOT_FOUND');
    return { deleted: true };
  } catch (error) {
    if (error instanceof Error && error.message === 'FRIENDSHIP_NOT_FOUND') throw error;
    throw new Error('Failed to remove friend.', { cause: error });
  }
}

export async function listFriendsAndRequests(userId: string) {
  try {
    const relations = await db
      .select()
      .from(friends)
      .where(or(eq(friends.requesterId, userId), eq(friends.addresseeId, userId)));

    const otherUserIds = Array.from(
      new Set(relations.map((r) => (r.requesterId === userId ? r.addresseeId : r.requesterId)))
    );

    const profilesMap = new Map<
      string,
      {
        userId: string;
        uniquePlayerId: string;
        displayName: string;
        avatarUrl: string | null;
        country: string | null;
        onlineStatus: string;
      }
    >();

    if (otherUserIds.length > 0) {
      const profiles = await db
        .select({
          userId: userProfiles.userId,
          uniquePlayerId: userProfiles.uniquePlayerId,
          displayName: userProfiles.displayName,
          avatarUrl: userProfiles.avatarUrl,
          country: userProfiles.country,
          onlineStatus: userProfiles.onlineStatus,
        })
        .from(userProfiles)
        .innerJoin(users, eq(userProfiles.userId, users.id));

      for (const p of profiles) {
        profilesMap.set(p.userId, p);
      }
    }

    const accepted = relations
      .filter((r) => r.status === 'ACCEPTED')
      .map((r) => {
        const otherId = r.requesterId === userId ? r.addresseeId : r.requesterId;
        return {
          friendshipId: r.id,
          ...profilesMap.get(otherId),
        };
      });

    const incomingRequests = relations
      .filter((r) => r.status === 'PENDING' && r.addresseeId === userId)
      .map((r) => ({
        friendshipId: r.id,
        ...profilesMap.get(r.requesterId),
        createdAt: r.createdAt,
      }));

    const outgoingRequests = relations
      .filter((r) => r.status === 'PENDING' && r.requesterId === userId)
      .map((r) => ({
        friendshipId: r.id,
        ...profilesMap.get(r.addresseeId),
        createdAt: r.createdAt,
      }));

    return { accepted, incomingRequests, outgoingRequests };
  } catch (error) {
    throw new Error('Failed to load friends list.', { cause: error });
  }
}
