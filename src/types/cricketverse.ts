import type {
  AvailabilityStatus,
  ExperienceLevel,
  NationalityCategory,
  OwnershipStatus,
  PlayerAttributes10,
  PlayingRole,
  PlayingXiValidationResult,
  SquadCompositionCounts,
  SquadRuleCheck,
  SquadRulesConfig,
  SquadValidationResult,
  ValuationBreakdown,
} from '../lib/cricketEngine.ts';

export type {
  AvailabilityStatus,
  ExperienceLevel,
  NationalityCategory,
  OwnershipStatus,
  PlayerAttributes10,
  PlayingRole,
  PlayingXiValidationResult,
  SquadCompositionCounts,
  SquadRuleCheck,
  SquadRulesConfig,
  SquadValidationResult,
  ValuationBreakdown,
};

export type SquadRoleCounts = SquadCompositionCounts;

export interface UserProfile {
  id: string;
  uniquePlayerId: string;
  displayName: string;
  avatarUrl: string | null;
  country: string | null;
  bio: string | null;
  preferredRole: string | null;
  onlineStatus: string;
}

export interface DbUser {
  id: string;
  uid: string;
  email: string;
  role: string;
  createdAt?: string;
  profile: UserProfile | null;
}

export interface FranchiseRecord {
  id: string;
  ownerId: string;
  ownerUid?: string;
  name: string;
  shortName: string;
  primaryColor: string;
  logoUrl: string | null;
  ownerName: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

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

export interface UserStatistics {
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

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  metadata?: { leagueId?: string; inviteCode?: string } | null;
  isRead: boolean;
  createdAt: string;
}

export interface FriendEntry {
  friendshipId: string;
  userId: string;
  uniquePlayerId: string;
  displayName: string;
  avatarUrl: string | null;
  country: string | null;
  onlineStatus: string;
  createdAt?: string;
}

export type LeagueStatus =
  | 'CREATED'
  | 'OPEN'
  | 'FULL'
  | 'READY'
  | 'AUCTION_IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'LOBBY'
  | 'AUCTION_LIVE'
  | 'PAUSED';

export interface LeagueSummary {
  id: string;
  name: string;
  description?: string;
  logoUrl?: string | null;
  inviteCode: string;
  inviteCodeActive?: boolean;
  inviteCodeExpiresAt?: string | null;
  visibility: 'PRIVATE' | 'PUBLIC';
  ownerId: string;
  ownerUid?: string;
  ownerName?: string | null;
  ownerPlayerId?: string | null;
  status: LeagueStatus;
  maxTeams: number;
  numberOfTeams?: number;
  purseAmount: number;
  minBasePrice?: number;
  minSquadSize: number;
  maxSquadSize: number;
  bidIncrement: number;
  timerSeconds: number;
  auctionMode: 'MEGA' | 'MINI' | 'FAST_TRACK';
  memberCount?: number;
  isMember?: boolean;
  memberIds?: string[];
  createdAt: string;
  updatedAt?: string;
}

export interface LeagueSettingsRecord {
  leagueId: string;
  minBatsmen: number;
  minBowlers: number;
  minAllRounders: number;
  minWicketkeepers: number;
  maxOverseas: number;
  allowAutoPick: boolean;
  allowTeamCustomization: boolean;
}

export interface LeagueMember {
  id: string;
  userId: string;
  uid?: string;
  role: string;
  isReady: boolean;
  joinedAt: string;
  displayName: string | null;
  uniquePlayerId: string | null;
  avatarUrl?: string | null;
  onlineStatus: string | null;
}

export interface PurchasedPlayerMini {
  playerId: string;
  playerCode: string;
  name: string;
  role: string;
  isOverseas: boolean;
  purchasePrice: number;
  imageUrl: string;
  overallRating: number;
}

export interface TeamRecord {
  id: string;
  leagueId: string;
  ownerId: string;
  ownerUid?: string;
  name: string;
  shortName: string;
  primaryColor: string;
  logoUrl?: string | null;
  totalPurse: number;
  remainingPurse: number;
  totalSpent?: number;
  availableSlots?: number;
  overseasCount?: number;
  batsmenCount?: number;
  bowlersCount?: number;
  allRoundersCount?: number;
  wicketkeepersCount?: number;
  purchasedPlayers?: PurchasedPlayerMini[];
  squadCount: number;
  squadStatus?: 'UNFILLED' | 'MEETS_MIN' | 'FULL';
  isSquadComplete?: boolean;
  captainPlayerId?: string | null;
  viceCaptainPlayerId?: string | null;
  wicketkeeperPlayerId?: string | null;
  ownerName?: string | null;
  ownerPlayerId?: string | null;
  leagueName?: string;
  leagueStatus?: string;
  minSquadSize?: number;
  maxSquadSize?: number;
}

export interface LeagueInvitationRecord {
  id: string;
  leagueId: string;
  leagueName: string;
  leagueVisibility?: 'PRIVATE' | 'PUBLIC';
  inviteCode: string;
  type: 'DIRECT_INVITE' | 'JOIN_REQUEST';
  senderId: string;
  senderUid?: string;
  senderName: string;
  senderPlayerId: string;
  recipientId: string;
  recipientUid?: string;
  recipientName: string;
  recipientPlayerId: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'REVOKED';
  expiresAt?: string | null;
  createdAt: string;
}

export interface LeagueActivityRecord {
  id: string;
  leagueId: string;
  leagueName?: string;
  actorId?: string | null;
  actorName?: string | null;
  actionType: string;
  message: string;
  createdAt: string;
}

export interface PlayerSeasonStat {
  id: string;
  playerId: string;
  seasonName: string;
  matchesPlayed: number;
  runs: number;
  strikeRate: number;
  wickets: number;
  economyRate: number;
  ratingOverall: number;
}

export interface CricketPlayer {
  id: string;
  playerCode: string;
  name: string;
  imageUrl: string;
  age: number;
  nationality: string;
  isOverseas: boolean;
  nationalityCategory: NationalityCategory;
  role: PlayingRole;
  battingStyle: string;
  bowlingStyle: string;
  battingRating: number;
  battingTiming: number;
  powerHitting: number;
  bowlingRating: number;
  bowlingAccuracy: number;
  swing: number;
  spin: number;
  fieldingRating: number;
  stamina: number;
  consistencyRating: number;
  experienceRating: number;
  overallRating: number;
  experienceLevel: ExperienceLevel;
  availabilityStatus: AvailabilityStatus;
  isActive: boolean;
  demandScore: number;
  valuationBreakdown?: ValuationBreakdown | null;
  basePrice: number;
  category: 'MARQUEE' | 'CAPS' | 'DOMESTIC' | 'EMERGING';
  seasonStats?: PlayerSeasonStat | null;
}

export interface RosterEntry {
  teamPlayerId: string;
  leagueId: string;
  teamId: string;
  playerId: string;
  purchasePrice: number;
  ownershipStatus: OwnershipStatus;
  isPlayingXi: boolean;
  isSubstitute: boolean;
  battingOrder: number | null;
  bowlingOrder: number | null;
  acquiredAt: string;
  player: CricketPlayer;
}

export interface TeamDetailsResponse {
  team: TeamRecord;
  league: LeagueSummary | null;
  settings: LeagueSettingsRecord | null;
  rules: SquadRulesConfig;
  roleCounts: SquadRoleCounts;
  squadValidation: SquadValidationResult;
  playingXiValidation: PlayingXiValidationResult;
  roster: RosterEntry[];
}

export type PlayerOrderMode = 'RANDOM' | 'ROLE_BASED' | 'ADMIN_DEFINED' | 'MANUAL';

export type AuctionStateValue =
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

export interface AuctionRecord {
  id: string;
  leagueId: string;
  name?: string | null;
  state: AuctionStateValue;
  currentLotId: string | null;
  currentPlayerId: string | null;
  currentBid: number | null;
  highestBidderTeamId: string | null;
  highestBidderUserId: string | null;
  lotDeadlineAt: string | null;
  pausedRemainingMs: number | null;
  lotOrder: number;
  totalLots: number;
  roundNumber?: number;
  timerSeconds?: number;
  maxTimerExtensions?: number | null;
  timerExtensionsUsed?: number;
  useTieredIncrements?: boolean;
  tier1Increment?: number;
  tier2Increment?: number;
  tier3Increment?: number;
  playerOrderMode?: PlayerOrderMode;
  manualPlayerIds?: string[] | null;
  basePriceOverrides?: Record<string, number> | null;
  playerPoolLimit?: number | null;
  enableSecondRound?: boolean;
  allowSkipPlayer?: boolean;
  scheduledStartAt?: string | null;
  settingsLocked?: boolean;
  unsoldCount?: number;
  soldCount?: number;
  queuedCount?: number;
  nextIncrement?: number;
}

export interface AuctionBidRecord {
  id: string;
  auctionId: string;
  leagueId: string;
  lotId: string;
  playerId: string;
  bidderUserId: string;
  teamId: string;
  amount: number;
  status: 'ACCEPTED' | 'REJECTED';
  rejectionReason?: string | null;
  isWinningBid: boolean;
  teamName?: string;
  teamShortName?: string;
  teamColor?: string;
  bidderName?: string;
  createdAt: string;
}

export interface AuctionHistoryItem {
  id: string;
  status: 'SOLD' | 'UNSOLD';
  finalPrice: number;
  finalizedAt: string;
  playerId: string;
  playerName: string;
  playerRole: string;
  playerCategory: string;
  playerImage: string;
  winningTeamId: string | null;
  winningTeamName: string | null;
  winningTeamShort: string | null;
  winningTeamColor: string | null;
}

export interface AuctionEventItem {
  id: string;
  eventType: string;
  amount: number | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuctionSnapshot {
  serverNow: number;
  league: LeagueSummary & { effectiveTimerSeconds?: number };
  settings?: LeagueSettingsRecord | null;
  auction: AuctionRecord;
  currentLot: { id: string; lotNumber: number; roundNumber?: number; basePrice: number; status: string } | null;
  currentPlayer: CricketPlayer | null;
  teams: TeamRecord[];
  bids?: AuctionBidRecord[];
  recentEvents: AuctionEventItem[];
  history: AuctionHistoryItem[];
  upNext: Array<{
    id: string;
    lotNumber: number;
    roundNumber?: number;
    basePrice: number;
    playerName: string;
    playerRole: string;
    playerCategory: string;
    isOverseas?: boolean;
    overallRating?: number;
  }>;
}

export interface AuctionDashboardOwner {
  userId: string;
  displayName: string;
  uniquePlayerId: string | null;
  teamName: string;
  teamShortName: string;
  primaryColor: string;
  remainingPurse: number;
  squadCount: number;
}

export interface AuctionDashboardItem {
  auctionId: string;
  leagueId: string;
  auctionName: string;
  leagueName: string;
  inviteCode: string;
  visibility: 'PRIVATE' | 'PUBLIC';
  leagueStatus: string;
  auctionState: AuctionStateValue;
  participatingTeamsCount: number;
  maxTeams: number;
  totalPlayersAvailable: number;
  soldPlayersCount: number;
  unsoldPlayersCount: number;
  roundNumber: number;
  scheduledStartAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  isMember: boolean;
  isOwner: boolean;
  ownerName: string;
  settingsLocked: boolean;
  participatingOwners: AuctionDashboardOwner[];
  config: {
    purseAmount: number;
    minSquadSize: number;
    maxSquadSize: number;
    maxOverseas: number;
    minBatsmen: number;
    minBowlers: number;
    minAllRounders: number;
    minWicketkeepers: number;
    bidIncrement: number;
    useTieredIncrements: boolean;
    tier1Increment: number;
    tier2Increment: number;
    tier3Increment: number;
    timerSeconds: number;
    maxTimerExtensions: number | null;
    playerOrderMode: PlayerOrderMode;
    manualPlayerIds: string[] | null;
    basePriceOverrides: Record<string, number> | null;
    playerPoolLimit: number | null;
    enableSecondRound: boolean;
    allowSkipPlayer: boolean;
    auctionMode: 'MEGA' | 'MINI' | 'FAST_TRACK';
  };
}

export interface AuctionDashboardResponse {
  auctions: AuctionDashboardItem[];
  live: AuctionDashboardItem[];
  upcoming: AuctionDashboardItem[];
  completed: AuctionDashboardItem[];
  joinable: AuctionDashboardItem[];
  history: Array<
    AuctionDashboardItem & {
      results: Array<{
        id: string;
        status: string;
        finalPrice: number;
        finalizedAt: string;
        playerName: string;
        playerRole: string;
        winningTeamName: string | null;
        winningTeamShort: string | null;
      }>;
    }
  >;
}

export function formatCurrency(lakhs: number): string {
  if (lakhs >= 100) {
    const cr = lakhs / 100;
    return `${cr % 1 === 0 ? cr.toFixed(0) : cr.toFixed(2)} Cr`;
  }
  return `${lakhs} L`;
}

