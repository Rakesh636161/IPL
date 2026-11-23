import { relations } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  role: text('role').notNull().default('USER'), // USER | ADMIN
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const userProfiles = pgTable('user_profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  uniquePlayerId: text('unique_player_id').notNull().unique(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  country: text('country').default('Global'),
  bio: text('bio').default('Franchise Owner'),
  preferredRole: text('preferred_role').default('Tactician'),
  onlineStatus: text('online_status').notNull().default('ONLINE'), // ONLINE | IN_AUCTION | OFFLINE
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const franchises = pgTable(
  'franchises',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: uuid('owner_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    shortName: text('short_name').notNull(),
    primaryColor: text('primary_color').notNull().default('#F97316'),
    logoUrl: text('logo_url'),
    ownerName: text('owner_name').notNull(),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('franchises_owner_idx').on(table.ownerId)]
);

export const friends = pgTable(
  'friends',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requesterId: uuid('requester_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    addresseeId: uuid('addressee_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    status: text('status').notNull().default('PENDING'), // PENDING | ACCEPTED | REJECTED | BLOCKED
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('friends_pair_unique_idx').on(table.requesterId, table.addresseeId),
    index('friends_addressee_idx').on(table.addresseeId),
  ]
);

export const leagues = pgTable(
  'leagues',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    logoUrl: text('logo_url'),
    inviteCode: text('invite_code').notNull().unique(),
    inviteCodeActive: boolean('invite_code_active').notNull().default(true),
    inviteCodeExpiresAt: timestamp('invite_code_expires_at'),
    visibility: text('visibility').notNull().default('PRIVATE'), // PRIVATE | PUBLIC
    ownerId: uuid('owner_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    status: text('status').notNull().default('OPEN'), // CREATED | OPEN | FULL | READY | AUCTION_IN_PROGRESS | COMPLETED | CANCELLED
    maxTeams: integer('max_teams').notNull().default(8),
    numberOfTeams: integer('number_of_teams').notNull().default(8),
    purseAmount: integer('purse_amount').notNull().default(10000), // Integer units (Lakhs: 10000 = 100 Cr)
    minBasePrice: integer('min_base_price').notNull().default(20), // Minimum player base price in Lakhs
    minSquadSize: integer('min_squad_size').notNull().default(15),
    maxSquadSize: integer('max_squad_size').notNull().default(25),
    bidIncrement: integer('bid_increment').notNull().default(25),
    timerSeconds: integer('timer_seconds').notNull().default(20),
    auctionMode: text('auction_mode').notNull().default('MEGA'), // MEGA | MINI | FAST_TRACK
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    check('leagues_max_teams_range', sql`${table.maxTeams} >= 2 AND ${table.maxTeams} <= 12`),
    check('leagues_purse_positive', sql`${table.purseAmount} > 0`),
  ]
);

export const leagueSettings = pgTable('league_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  leagueId: uuid('league_id')
    .references(() => leagues.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  minBatsmen: integer('min_batsmen').notNull().default(4),
  minBowlers: integer('min_bowlers').notNull().default(4),
  minAllRounders: integer('min_all_rounders').notNull().default(2),
  minWicketkeepers: integer('min_wicketkeepers').notNull().default(1),
  maxOverseas: integer('max_overseas').notNull().default(8),
  allowAutoPick: boolean('allow_auto_pick').notNull().default(false),
  allowTeamCustomization: boolean('allow_team_customization').notNull().default(true),
});

export const leagueMembers = pgTable(
  'league_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    leagueId: uuid('league_id')
      .references(() => leagues.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    role: text('role').notNull().default('MEMBER'), // OWNER | MEMBER
    isReady: boolean('is_ready').notNull().default(false),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
  },
  (table) => [uniqueIndex('league_members_unique_idx').on(table.leagueId, table.userId)]
);

export const leagueInvitations = pgTable(
  'league_invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    leagueId: uuid('league_id')
      .references(() => leagues.id, { onDelete: 'cascade' })
      .notNull(),
    type: text('type').notNull().default('DIRECT_INVITE'), // DIRECT_INVITE | JOIN_REQUEST
    senderId: uuid('sender_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    recipientId: uuid('recipient_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    inviteCode: text('invite_code').notNull(),
    status: text('status').notNull().default('PENDING'), // PENDING | ACCEPTED | REJECTED | EXPIRED | REVOKED
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('league_invitations_league_idx').on(table.leagueId, table.status),
    index('league_invitations_recipient_idx').on(table.recipientId, table.status),
  ]
);

export const leagueActivity = pgTable(
  'league_activity',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    leagueId: uuid('league_id')
      .references(() => leagues.id, { onDelete: 'cascade' })
      .notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actionType: text('action_type').notNull(),
    message: text('message').notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('league_activity_league_idx').on(table.leagueId, table.createdAt)]
);

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    leagueId: uuid('league_id')
      .references(() => leagues.id, { onDelete: 'cascade' })
      .notNull(),
    ownerId: uuid('owner_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    shortName: text('short_name').notNull(),
    primaryColor: text('primary_color').notNull().default('#D4AF37'),
    logoUrl: text('logo_url'),
    totalPurse: integer('total_purse').notNull(),
    remainingPurse: integer('remaining_purse').notNull(),
    squadCount: integer('squad_count').notNull().default(0),
    isSquadComplete: boolean('is_squad_complete').notNull().default(false),
    captainPlayerId: uuid('captain_player_id'),
    viceCaptainPlayerId: uuid('vice_captain_player_id'),
    wicketkeeperPlayerId: uuid('wicketkeeper_player_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('teams_league_owner_unique_idx').on(table.leagueId, table.ownerId),
    check('teams_purse_non_negative', sql`${table.remainingPurse} >= 0`),
  ]
);

export const players = pgTable(
  'players',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    playerCode: text('player_code').notNull().unique(),
    name: text('name').notNull(),
    imageUrl: text('image_url').notNull(),
    age: integer('age').notNull(),
    nationality: text('nationality').notNull(),
    isOverseas: boolean('is_overseas').notNull().default(false),
    nationalityCategory: text('nationality_category').notNull().default('DOMESTIC'), // DOMESTIC | OVERSEAS
    role: text('role').notNull(), // BATSMAN | OPENING_BATSMAN | MIDDLE_ORDER_BATSMAN | BOWLER | ALL_ROUNDER | WICKETKEEPER | FAST_BOWLER | SPIN_BOWLER
    battingStyle: text('batting_style').notNull(),
    bowlingStyle: text('bowling_style').notNull(),
    battingRating: integer('batting_rating').notNull(),
    battingTiming: integer('batting_timing').notNull().default(70),
    powerHitting: integer('power_hitting').notNull().default(70),
    bowlingRating: integer('bowling_rating').notNull(),
    bowlingAccuracy: integer('bowling_accuracy').notNull().default(65),
    swing: integer('swing').notNull().default(45),
    spin: integer('spin').notNull().default(45),
    fieldingRating: integer('fielding_rating').notNull(),
    stamina: integer('stamina').notNull().default(75),
    consistencyRating: integer('consistency_rating').notNull(),
    experienceRating: integer('experience_rating').notNull(),
    overallRating: integer('overall_rating').notNull().default(75),
    experienceLevel: text('experience_level').notNull().default('PROFESSIONAL'), // EMERGING | PROFESSIONAL | EXPERIENCED | ELITE
    availabilityStatus: text('availability_status').notNull().default('AVAILABLE'), // AVAILABLE | INJURED | INACTIVE
    isActive: boolean('is_active').notNull().default(true),
    demandScore: integer('demand_score').notNull().default(100), // 100 = 1.00x
    valuationBreakdown: jsonb('valuation_breakdown'),
    basePrice: integer('base_price').notNull(),
    category: text('category').notNull(), // MARQUEE | CAPS | DOMESTIC | EMERGING
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('players_role_idx').on(table.role),
    index('players_category_idx').on(table.category),
  ]
);

export const playerSeasons = pgTable('player_seasons', {
  id: uuid('id').defaultRandom().primaryKey(),
  playerId: uuid('player_id')
    .references(() => players.id, { onDelete: 'cascade' })
    .notNull(),
  seasonName: text('season_name').notNull(),
  matchesPlayed: integer('matches_played').notNull().default(0),
  runs: integer('runs').notNull().default(0),
  strikeRate: integer('strike_rate').notNull().default(120), // stored x1 or integer
  wickets: integer('wickets').notNull().default(0),
  economyRate: integer('economy_rate').notNull().default(800), // stored x100 (e.g. 745 = 7.45)
  ratingOverall: integer('rating_overall').notNull().default(75),
});

export const auctions = pgTable('auctions', {
  id: uuid('id').defaultRandom().primaryKey(),
  leagueId: uuid('league_id')
    .references(() => leagues.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  name: text('name'),
  state: text('state').notNull().default('WAITING'), // CREATED | WAITING | LIVE | BIDDING | AWAITING_FINALIZATION | SOLD | UNSOLD | PAUSED | COMPLETED | CANCELLED
  currentLotId: uuid('current_lot_id'),
  currentPlayerId: uuid('current_player_id').references(() => players.id),
  currentBid: integer('current_bid'),
  highestBidderTeamId: uuid('highest_bidder_team_id').references(() => teams.id),
  highestBidderUserId: uuid('highest_bidder_user_id').references(() => users.id),
  lotDeadlineAt: timestamp('lot_deadline_at'),
  pausedRemainingMs: integer('paused_remaining_ms'),
  previousStateBeforePause: text('previous_state_before_pause'),
  lotOrder: integer('lot_order').notNull().default(0),
  totalLots: integer('total_lots').notNull().default(0),
  timerSeconds: integer('timer_seconds').notNull().default(20),
  maxTimerExtensions: integer('max_timer_extensions'),
  timerExtensionsUsed: integer('timer_extensions_used').notNull().default(0),
  useTieredIncrements: boolean('use_tiered_increments').notNull().default(true),
  tier1Increment: integer('tier1_increment').notNull().default(5),
  tier2Increment: integer('tier2_increment').notNull().default(10),
  tier3Increment: integer('tier3_increment').notNull().default(25),
  playerOrderMode: text('player_order_mode').notNull().default('ADMIN_DEFINED'), // RANDOM | ROLE_BASED | ADMIN_DEFINED | MANUAL
  manualPlayerIds: jsonb('manual_player_ids'),
  basePriceOverrides: jsonb('base_price_overrides'),
  playerPoolLimit: integer('player_pool_limit'),
  enableSecondRound: boolean('enable_second_round').notNull().default(true),
  roundNumber: integer('round_number').notNull().default(1),
  allowSkipPlayer: boolean('allow_skip_player').notNull().default(true),
  scheduledStartAt: timestamp('scheduled_start_at'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const auctionLots = pgTable(
  'auction_lots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    auctionId: uuid('auction_id')
      .references(() => auctions.id, { onDelete: 'cascade' })
      .notNull(),
    playerId: uuid('player_id')
      .references(() => players.id, { onDelete: 'cascade' })
      .notNull(),
    lotNumber: integer('lot_number').notNull(),
    roundNumber: integer('round_number').notNull().default(1),
    basePrice: integer('base_price').notNull(),
    status: text('status').notNull().default('QUEUED'), // QUEUED | ACTIVE | SOLD | UNSOLD | SKIPPED
    soldPrice: integer('sold_price'),
    winningTeamId: uuid('winning_team_id').references(() => teams.id),
    finalizedAt: timestamp('finalized_at'),
  },
  (table) => [
    uniqueIndex('auction_lots_auction_player_idx').on(table.auctionId, table.playerId),
    index('auction_lots_auction_status_idx').on(table.auctionId, table.status),
  ]
);

export const auctionBids = pgTable(
  'auction_bids',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    auctionId: uuid('auction_id')
      .references(() => auctions.id, { onDelete: 'cascade' })
      .notNull(),
    leagueId: uuid('league_id')
      .references(() => leagues.id, { onDelete: 'cascade' })
      .notNull(),
    lotId: uuid('lot_id')
      .references(() => auctionLots.id, { onDelete: 'cascade' })
      .notNull(),
    playerId: uuid('player_id')
      .references(() => players.id, { onDelete: 'cascade' })
      .notNull(),
    bidderUserId: uuid('bidder_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    teamId: uuid('team_id')
      .references(() => teams.id, { onDelete: 'cascade' })
      .notNull(),
    amount: integer('amount').notNull(),
    status: text('status').notNull().default('ACCEPTED'), // ACCEPTED | REJECTED
    rejectionReason: text('rejection_reason'),
    idempotencyKey: text('idempotency_key'),
    isWinningBid: boolean('is_winning_bid').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('auction_bids_auction_idx').on(table.auctionId, table.createdAt),
    index('auction_bids_lot_idx').on(table.lotId, table.createdAt),
  ]
);

export const auctionEvents = pgTable(
  'auction_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    auctionId: uuid('auction_id')
      .references(() => auctions.id, { onDelete: 'cascade' })
      .notNull(),
    lotId: uuid('lot_id').references(() => auctionLots.id),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    teamId: uuid('team_id').references(() => teams.id),
    eventType: text('event_type').notNull(), // AUCTION_STARTED | AUCTION_CONFIGURED | LOT_OPENED | BID_PLACED | BID_REJECTED | PAUSED | RESUMED | LOT_SOLD | LOT_UNSOLD | LOT_SKIPPED | ROUND_STARTED | AUCTION_COMPLETED | AUCTION_CANCELLED
    amount: integer('amount'),
    idempotencyKey: text('idempotency_key'),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('auction_events_idempotency_idx').on(table.auctionId, table.idempotencyKey),
    index('auction_events_auction_idx').on(table.auctionId, table.createdAt),
  ]
);

export const auctionResults = pgTable(
  'auction_results',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    auctionId: uuid('auction_id')
      .references(() => auctions.id, { onDelete: 'cascade' })
      .notNull(),
    leagueId: uuid('league_id')
      .references(() => leagues.id, { onDelete: 'cascade' })
      .notNull(),
    lotId: uuid('lot_id')
      .references(() => auctionLots.id, { onDelete: 'cascade' })
      .notNull()
      .unique(),
    playerId: uuid('player_id')
      .references(() => players.id, { onDelete: 'cascade' })
      .notNull(),
    winningTeamId: uuid('winning_team_id').references(() => teams.id),
    finalPrice: integer('final_price').notNull().default(0),
    status: text('status').notNull(), // SOLD | UNSOLD
    finalizedAt: timestamp('finalized_at').defaultNow().notNull(),
  },
  (table) => [uniqueIndex('auction_results_league_player_idx').on(table.leagueId, table.playerId)]
);

export const teamPlayers = pgTable(
  'team_players',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    leagueId: uuid('league_id')
      .references(() => leagues.id, { onDelete: 'cascade' })
      .notNull(),
    teamId: uuid('team_id')
      .references(() => teams.id, { onDelete: 'cascade' })
      .notNull(),
    playerId: uuid('player_id')
      .references(() => players.id, { onDelete: 'cascade' })
      .notNull(),
    purchasePrice: integer('purchase_price').notNull(),
    ownershipStatus: text('ownership_status').notNull().default('OWNED'), // OWNED | RELEASED | LOANED
    isPlayingXi: boolean('is_playing_xi').notNull().default(false),
    isSubstitute: boolean('is_substitute').notNull().default(false),
    battingOrder: integer('batting_order'),
    bowlingOrder: integer('bowling_order'),
    acquiredAt: timestamp('acquired_at').defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('team_players_league_player_unique_idx').on(table.leagueId, table.playerId),
    index('team_players_team_idx').on(table.teamId),
  ]
);

export const fixtures = pgTable('fixtures', {
  id: uuid('id').defaultRandom().primaryKey(),
  leagueId: uuid('league_id')
    .references(() => leagues.id, { onDelete: 'cascade' })
    .notNull(),
  homeTeamId: uuid('home_team_id')
    .references(() => teams.id, { onDelete: 'cascade' })
    .notNull(),
  awayTeamId: uuid('away_team_id')
    .references(() => teams.id, { onDelete: 'cascade' })
    .notNull(),
  roundNumber: integer('round_number').notNull(),
  scheduledAt: timestamp('scheduled_at').defaultNow().notNull(),
  status: text('status').notNull().default('SCHEDULED'), // SCHEDULED | LIVE | COMPLETED
});

export const matches = pgTable('matches', {
  id: uuid('id').defaultRandom().primaryKey(),
  fixtureId: uuid('fixture_id').references(() => fixtures.id, { onDelete: 'cascade' }),
  leagueId: uuid('league_id').references(() => leagues.id, { onDelete: 'cascade' }),
  homeTeamId: uuid('home_team_id')
    .references(() => teams.id, { onDelete: 'cascade' })
    .notNull(),
  awayTeamId: uuid('away_team_id')
    .references(() => teams.id, { onDelete: 'cascade' })
    .notNull(),
  mode: text('mode').notNull().default('TOURNAMENT'), // AI | 1V1 | TOURNAMENT
  winnerTeamId: uuid('winner_team_id').references(() => teams.id),
  summaryText: text('summary_text'),
  status: text('status').notNull().default('PENDING'), // PENDING | IN_PROGRESS | COMPLETED
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const matchInnings = pgTable('match_innings', {
  id: uuid('id').defaultRandom().primaryKey(),
  matchId: uuid('match_id')
    .references(() => matches.id, { onDelete: 'cascade' })
    .notNull(),
  battingTeamId: uuid('batting_team_id')
    .references(() => teams.id, { onDelete: 'cascade' })
    .notNull(),
  inningsNumber: integer('innings_number').notNull(),
  runs: integer('runs').notNull().default(0),
  wickets: integer('wickets').notNull().default(0),
  overs: integer('overs').notNull().default(0),
  balls: integer('balls').notNull().default(0),
});

export const matchEvents = pgTable('match_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  matchId: uuid('match_id')
    .references(() => matches.id, { onDelete: 'cascade' })
    .notNull(),
  inningsId: uuid('innings_id')
    .references(() => matchInnings.id, { onDelete: 'cascade' })
    .notNull(),
  overNumber: integer('over_number').notNull(),
  ballNumber: integer('ball_number').notNull(),
  runsScored: integer('runs_scored').notNull().default(0),
  isWicket: boolean('is_wicket').notNull().default(false),
  commentary: text('commentary').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const standings = pgTable(
  'standings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    leagueId: uuid('league_id')
      .references(() => leagues.id, { onDelete: 'cascade' })
      .notNull(),
    teamId: uuid('team_id')
      .references(() => teams.id, { onDelete: 'cascade' })
      .notNull(),
    played: integer('played').notNull().default(0),
    won: integer('won').notNull().default(0),
    lost: integer('lost').notNull().default(0),
    tied: integer('tied').notNull().default(0),
    points: integer('points').notNull().default(0),
    netRunRateScaled: integer('net_run_rate_scaled').notNull().default(0),
  },
  (table) => [uniqueIndex('standings_league_team_unique_idx').on(table.leagueId, table.teamId)]
);

export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  type: text('type').notNull(), // FRIEND_REQUEST | LEAGUE_INVITE | AUCTION_ALERT | SYSTEM
  title: text('title').notNull(),
  message: text('message').notNull(),
  metadata: jsonb('metadata'),
  isRead: boolean('is_read').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  details: jsonb('details'),
  ipAddress: text('ip_address'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// PostgreSQL-backed distributed locks & ephemeral real-time state (replaces Redis)
export const distributedLocks = pgTable(
  'distributed_locks',
  {
    lockKey: text('lock_key').primaryKey(),
    holderId: text('holder_id').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('distributed_locks_expires_idx').on(table.expiresAt)]
);

export const realtimeCache = pgTable(
  'realtime_cache',
  {
    cacheKey: text('cache_key').primaryKey(),
    value: jsonb('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('realtime_cache_expires_idx').on(table.expiresAt)]
);

// Drizzle Relations
export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(userProfiles, { fields: [users.id], references: [userProfiles.userId] }),
  memberships: many(leagueMembers),
  teams: many(teams),
  notifications: many(notifications),
}));

export const userProfilesRelations = relations(userProfiles, ({ one }) => ({
  user: one(users, { fields: [userProfiles.userId], references: [users.id] }),
}));

export const leaguesRelations = relations(leagues, ({ one, many }) => ({
  owner: one(users, { fields: [leagues.ownerId], references: [users.id] }),
  settings: one(leagueSettings, { fields: [leagues.id], references: [leagueSettings.leagueId] }),
  members: many(leagueMembers),
  teams: many(teams),
  auction: one(auctions, { fields: [leagues.id], references: [auctions.leagueId] }),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  league: one(leagues, { fields: [teams.leagueId], references: [leagues.id] }),
  owner: one(users, { fields: [teams.ownerId], references: [users.id] }),
  roster: many(teamPlayers),
}));

export const playersRelations = relations(players, ({ many }) => ({
  seasons: many(playerSeasons),
}));
