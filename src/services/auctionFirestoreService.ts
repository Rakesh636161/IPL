import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase.ts';
import { AuctionSnapshot } from '../types/cricketverse.ts';

/**
 * Mirrors authoritative backend auction state and team purse snapshots to Cloud Firestore
 * for multi-device observability without blocking or overriding the authoritative Socket.IO / SQL ledger.
 */
export async function syncAuctionSnapshotToFirestore(snapshot: AuctionSnapshot, currentUserUid: string) {
  const leagueId = snapshot.league.id;
  const auction = snapshot.auction;
  const memberIds = Array.from(
    new Set(
      [snapshot.league.ownerUid, ...snapshot.teams.map((t) => t.ownerUid)].filter(
        (v): v is string => typeof v === 'string' && v.length > 0
      )
    )
  ).slice(0, 12);

  if (memberIds.length === 0) return;

  try {
    const ownerUid = snapshot.league.ownerUid || currentUserUid;
    await setDoc(
      doc(db, 'auctions', leagueId),
      {
        auctionId: auction.id,
        leagueId,
        ownerId: ownerUid,
        memberIds,
        name: auction.name || `${snapshot.league.name} Auction`,
        state: auction.state,
        currentLotId: auction.currentLotId ?? null,
        currentPlayerId: auction.currentPlayerId ?? null,
        currentBid: auction.currentBid ?? null,
        highestBidderTeamId: auction.highestBidderTeamId ?? null,
        highestBidderUserId: auction.highestBidderUserId ?? null,
        lotDeadlineAt: auction.lotDeadlineAt ?? null,
        pausedRemainingMs: auction.pausedRemainingMs ?? null,
        lotOrder: auction.lotOrder ?? 0,
        totalLots: auction.totalLots ?? 0,
        roundNumber: auction.roundNumber ?? 1,
        timerSeconds: auction.timerSeconds ?? snapshot.league.timerSeconds ?? 20,
        maxTimerExtensions: auction.maxTimerExtensions ?? null,
        useTieredIncrements: auction.useTieredIncrements ?? true,
        tier1Increment: auction.tier1Increment ?? 5,
        tier2Increment: auction.tier2Increment ?? 10,
        tier3Increment: auction.tier3Increment ?? 25,
        playerOrderMode: auction.playerOrderMode ?? 'ADMIN_DEFINED',
        enableSecondRound: auction.enableSecondRound ?? true,
        allowSkipPlayer: auction.allowSkipPlayer ?? true,
        settingsLocked: Boolean(auction.settingsLocked),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    // Non-blocking audit mirror; handleFirestoreError reports permission/schema issues in standardized format
    try {
      handleFirestoreError(err, OperationType.WRITE, `auctions/${leagueId}`);
    } catch {
      // Prevent client Firestore mirror failure from disrupting Socket.IO live bidding
    }
  }
}

export async function syncAuctionParticipantPresence(params: {
  leagueId: string;
  leagueOwnerUid: string;
  userUid: string;
  teamId: string;
  teamName: string;
  ownerName: string;
  connectionStatus: 'CONNECTED' | 'DISCONNECTED';
}) {
  const participantId = `${params.leagueId}__${params.userUid}`;
  try {
    await setDoc(
      doc(db, 'auction_participants', participantId),
      {
        participantId,
        leagueId: params.leagueId,
        leagueOwnerId: params.leagueOwnerUid,
        userId: params.userUid,
        teamId: params.teamId,
        teamName: params.teamName.slice(0, 40),
        ownerName: params.ownerName.slice(0, 40),
        connectionStatus: params.connectionStatus,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    try {
      handleFirestoreError(err, OperationType.WRITE, `auction_participants/${participantId}`);
    } catch {
      // Non-blocking presence mirror
    }
  }
}
