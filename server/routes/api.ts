import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, or } from 'drizzle-orm';
import { AuthRequest, requireAdmin, requireAuth } from '../middleware/auth.ts';
import { db } from '../../src/db/index.ts';
import { ensurePlayersSeeded } from '../../src/db/seedPlayers.ts';
import { notifications, players, playerSeasons, userProfiles } from '../../src/db/schema.ts';
import { getUserStatistics } from '../services/userStatsService.ts';
import {
  createFranchise,
  deleteFranchise,
  listUserFranchises,
  updateFranchise,
} from '../services/franchiseService.ts';
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
} from '../services/leagueService.ts';
import {
  listFriendsAndRequests,
  removeFriend,
  respondToFriendRequest,
  searchUsersByPlayerId,
  sendFriendRequest,
} from '../services/friendService.ts';
import {
  cancelAuction,
  configureAuction,
  endAuction,
  finalizeCurrentLot,
  getAuctionSnapshot,
  listAuctionDashboard,
  pauseAuction,
  placeBid,
  resumeAuction,
  skipCurrentLot,
  startAuction,
  startUnsoldRound,
} from '../services/auctionEngine.ts';
import {
  assignPlayerToTeamInLeague,
  getTeamWithRoster,
  getUserTeams,
  markTeamSquadComplete,
  updateTeamLineup,
} from '../services/teamService.ts';
import {
  createAdminPlayer,
  getPlayerDetailById,
  importAdminPlayers,
  listFilteredPlayers,
  updateAdminPlayer,
} from '../services/playerService.ts';
import { getLeagueStandingsAndMatches, simulateQuickMatch } from '../services/matchService.ts';
import { logEvent } from '../lib/logger.ts';

export const apiRouter = Router();

const bidLimiter = rateLimit({
  windowMs: 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bid requests. Please slow down.' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
});

apiRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'cricketverse-api', timestamp: new Date().toISOString() });
});

// Profile & Auth Session Bootstrap
apiRouter.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await ensurePlayersSeeded();
    const user = req.dbUser!;
    const unreadNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user.id))
      .orderBy(desc(notifications.createdAt))
      .limit(25);

    res.json({
      user,
      notifications: unreadNotifs,
    });
  } catch (error) {
    logEvent('ERROR', 'API', 'GET /me failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to load profile.' });
  }
});

const updateProfileSchema = z.object({
  displayName: z.string().min(2).max(40),
  avatarUrl: z
    .string()
    .max(500)
    .refine(
      (val) =>
        val === '' ||
        val.startsWith('https://') ||
        val.startsWith('http://') ||
        val.startsWith('/src/assets/'),
      'Avatar URL must be a valid HTTP(S) URL or built-in asset path'
    )
    .nullable()
    .optional(),
  country: z.string().max(40).optional(),
  bio: z.string().max(160).optional(),
  preferredRole: z.string().max(40).optional(),
});

apiRouter.get('/me/stats', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const stats = await getUserStatistics(req.dbUser!.id, req.dbUser!.uid);
    res.json({ stats });
  } catch (error) {
    logEvent('ERROR', 'API', 'GET /me/stats failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to load player statistics.' });
  }
});

apiRouter.post('/me/offline', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.dbUser!;
    await db
      .update(userProfiles)
      .set({ onlineStatus: 'OFFLINE', lastSeenAt: new Date() })
      .where(eq(userProfiles.userId, user.id));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to update offline status.' });
  }
});

apiRouter.patch('/me/profile', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid profile fields', details: parsed.error.flatten() });
  }

  try {
    const cleanName = parsed.data.displayName.trim();
    const updateValues: Partial<typeof userProfiles.$inferInsert> = {
      displayName: cleanName,
      updatedAt: new Date(),
    };
    if (parsed.data.avatarUrl !== undefined) {
      updateValues.avatarUrl = parsed.data.avatarUrl ? parsed.data.avatarUrl.trim() : null;
    }
    if (parsed.data.country !== undefined) {
      updateValues.country = parsed.data.country.trim();
    }
    if (parsed.data.bio !== undefined) {
      updateValues.bio = parsed.data.bio.trim();
    }
    if (parsed.data.preferredRole !== undefined) {
      updateValues.preferredRole = parsed.data.preferredRole.trim();
    }

    const [updated] = await db
      .update(userProfiles)
      .set(updateValues)
      .where(eq(userProfiles.userId, req.dbUser!.id))
      .returning();

    res.json({ profile: updated });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

apiRouter.post('/notifications/:id/read', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.id, String(req.params.id)), eq(notifications.userId, req.dbUser!.id)));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to mark notification read.' });
  }
});

// Friends
apiRouter.get('/friends', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const data = await listFriendsAndRequests(req.dbUser!.id);
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Failed to load friends.' });
  }
});

apiRouter.get('/friends/search', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const q = String(req.query.q || '');
    const results = await searchUsersByPlayerId(req.dbUser!.id, q);
    res.json({ users: results });
  } catch {
    res.status(500).json({ error: 'Search failed.' });
  }
});

apiRouter.post('/friends/request', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const schema = z.object({ uniquePlayerId: z.string().min(4).max(32) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Valid uniquePlayerId required' });

  try {
    const result = await sendFriendRequest(req.dbUser!.id, parsed.data.uniquePlayerId);
    res.status(201).json({ friendship: result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      PLAYER_NOT_FOUND: { code: 404, msg: 'No player found with that Unique Player ID.' },
      CANNOT_ADD_SELF: { code: 400, msg: 'You cannot send a friend request to yourself.' },
      ALREADY_FRIENDS: { code: 409, msg: 'You are already friends with this player.' },
      REQUEST_PENDING: { code: 409, msg: 'A friend request is already pending.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 500).json({ error: hit?.msg ?? 'Failed to send friend request.' });
  }
});

apiRouter.post('/friends/respond', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const schema = z.object({ friendshipId: z.string().uuid(), action: z.enum(['ACCEPT', 'REJECT']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request payload' });

  try {
    const updated = await respondToFriendRequest(req.dbUser!.id, parsed.data.friendshipId, parsed.data.action);
    res.json({ friendship: updated });
  } catch (error) {
    if (error instanceof Error && error.message === 'REQUEST_NOT_FOUND') {
      return res.status(404).json({ error: 'Friend request not found.' });
    }
    res.status(500).json({ error: 'Failed to respond to request.' });
  }
});

apiRouter.delete('/friends/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await removeFriend(req.dbUser!.id, String(req.params.id));
    res.json(result);
  } catch {
    res.status(404).json({ error: 'Friendship not found.' });
  }
});

// Safe Logo URL or small resized base64 image data URL (PNG/JPEG/WebP only)
const optionalLogoUrlSchema = z
  .string()
  .max(180_000)
  .refine(
    (val) =>
      val === '' ||
      (val.startsWith('https://') && val.length <= 500) ||
      (val.startsWith('http://') && val.length <= 500) ||
      (val.startsWith('/src/assets/') && val.length <= 300) ||
      /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i.test(val),
    'Logo must be a built-in crest, HTTPS URL, or uploaded PNG/JPEG/WebP image under 180KB'
  )
  .nullable()
  .optional();

// Standalone User Franchises
const createFranchiseSchema = z.object({
  name: z.string().min(2).max(40),
  shortName: z.string().min(2).max(4),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  logoUrl: optionalLogoUrlSchema,
  ownerName: z.string().min(2).max(40).optional(),
  description: z.string().max(240).optional(),
});

const updateFranchiseSchema = z.object({
  name: z.string().min(2).max(40).optional(),
  shortName: z.string().min(2).max(4).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  logoUrl: optionalLogoUrlSchema,
  ownerName: z.string().min(2).max(40).optional(),
  description: z.string().max(240).optional(),
});

apiRouter.get('/franchises', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const items = await listUserFranchises(req.dbUser!.id);
    res.json({ franchises: items });
  } catch {
    res.status(500).json({ error: 'Failed to fetch franchises.' });
  }
});

apiRouter.post('/franchises', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const parsed = createFranchiseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid franchise details.', details: parsed.error.flatten() });
  }
  try {
    const franchise = await createFranchise(req.dbUser!.id, parsed.data);
    res.status(201).json({ franchise });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      INVALID_FRANCHISE_NAME: { code: 400, msg: 'Franchise name must be 2–40 characters.' },
      INVALID_SHORT_NAME: { code: 400, msg: 'Short name must be 2–4 alphanumeric characters.' },
      INVALID_OWNER_NAME: { code: 400, msg: 'Owner name must be 2–40 characters.' },
      INVALID_LOGO_URL: { code: 400, msg: 'Invalid franchise logo format or image exceeds size limit.' },
      DUPLICATE_FRANCHISE_NAME: { code: 409, msg: 'You already own a franchise with this name.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 500).json({ error: hit?.msg ?? 'Failed to create franchise.' });
  }
});

apiRouter.patch('/franchises/:id', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const parsed = updateFranchiseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid franchise update payload.' });
  }
  try {
    const franchise = await updateFranchise(req.dbUser!.id, String(req.params.id), parsed.data);
    res.json({ franchise });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      FRANCHISE_NOT_FOUND: { code: 404, msg: 'Franchise not found.' },
      FORBIDDEN: { code: 403, msg: 'Only the franchise owner can edit this franchise.' },
      INVALID_FRANCHISE_NAME: { code: 400, msg: 'Franchise name must be 2–40 characters.' },
      INVALID_SHORT_NAME: { code: 400, msg: 'Short name must be 2–4 alphanumeric characters.' },
      INVALID_OWNER_NAME: { code: 400, msg: 'Owner name must be 2–40 characters.' },
      INVALID_LOGO_URL: { code: 400, msg: 'Invalid franchise logo format or image exceeds size limit.' },
      DUPLICATE_FRANCHISE_NAME: { code: 409, msg: 'You already own another franchise with this name.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 500).json({ error: hit?.msg ?? 'Failed to update franchise.' });
  }
});

apiRouter.delete('/franchises/:id', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const result = await deleteFranchise(req.dbUser!.id, String(req.params.id));
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    if (msg === 'FRANCHISE_NOT_FOUND') return res.status(404).json({ error: 'Franchise not found.' });
    if (msg === 'FORBIDDEN') return res.status(403).json({ error: 'Only the franchise owner can delete this franchise.' });
    res.status(500).json({ error: 'Failed to delete franchise.' });
  }
});

// Leagues

apiRouter.get('/leagues', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const data = await listUserLeagues(req.dbUser!.id);
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Failed to fetch leagues.' });
  }
});

apiRouter.get('/leagues/validate-code', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const code = String(req.query.code || '').trim();
    if (code.length < 4) {
      return res.status(400).json({ error: 'Invitation code is too short.' });
    }
    const preview = await validateInviteCodePreview(req.dbUser!.id, code);
    res.json(preview);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'Invalid league invitation code.' },
      INVITE_REVOKED: { code: 410, msg: 'This invitation code has been revoked by the owner.' },
      INVITE_EXPIRED: { code: 410, msg: 'This invitation code has expired.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 500).json({ error: hit?.msg ?? 'Failed to validate code.' });
  }
});

const createLeagueSchema = z.object({
  name: z.string().min(3).max(60),
  description: z.string().max(300).optional(),
  logoUrl: optionalLogoUrlSchema,
  visibility: z.enum(['PRIVATE', 'PUBLIC']),
  maxTeams: z.number().int().min(2).max(12),
  numberOfTeams: z.number().int().min(2).max(12).optional(),
  purseAmount: z.number().int().min(1000).max(100000),
  minBasePrice: z.number().int().min(10).max(2000).optional(),
  minSquadSize: z.number().int().min(11).max(25),
  maxSquadSize: z.number().int().min(11).max(25),
  bidIncrement: z.number().int().min(5).max(500),
  timerSeconds: z.number().int().min(5).max(60),
  auctionMode: z.enum(['MEGA', 'MINI', 'FAST_TRACK']),
  teamName: z.string().min(2).max(40),
  teamShortName: z.string().min(2).max(4),
  teamLogoUrl: optionalLogoUrlSchema,
  teamPrimaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  inviteCodeExpiresInHours: z.number().int().min(1).max(720).nullable().optional(),
  settings: z
    .object({
      minBatsmen: z.number().int().min(0).max(10).optional(),
      minBowlers: z.number().int().min(0).max(10).optional(),
      minAllRounders: z.number().int().min(0).max(10).optional(),
      minWicketkeepers: z.number().int().min(0).max(5).optional(),
      maxOverseas: z.number().int().min(0).max(11).optional(),
      allowAutoPick: z.boolean().optional(),
      allowTeamCustomization: z.boolean().optional(),
    })
    .optional(),
});

apiRouter.post('/leagues', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const parsed = createLeagueSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid league configuration', details: parsed.error.flatten() });
  }
  if (parsed.data.maxSquadSize < parsed.data.minSquadSize) {
    return res.status(400).json({ error: 'Maximum players allowed must be >= minimum players required.' });
  }

  try {
    const created = await createLeague(req.dbUser!.id, parsed.data);
    res.status(201).json(created);
  } catch {
    res.status(500).json({ error: 'Failed to create league.' });
  }
});

apiRouter.post('/leagues/join', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    inviteCode: z.string().min(4).max(20),
    teamName: z.string().min(2).max(40),
    teamShortName: z.string().min(2).max(4),
    teamLogoUrl: optionalLogoUrlSchema,
    teamPrimaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid invite code or team name' });

  try {
    const result = await joinLeagueByCode(
      req.dbUser!.id,
      parsed.data.inviteCode,
      parsed.data.teamName,
      parsed.data.teamShortName,
      parsed.data.teamLogoUrl,
      parsed.data.teamPrimaryColor
    );
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'Invalid league invitation code.' },
      INVITE_REVOKED: { code: 410, msg: 'This invitation code has been revoked.' },
      INVITE_EXPIRED: { code: 410, msg: 'This invitation code has expired.' },
      ALREADY_MEMBER: { code: 409, msg: 'You are already a member of this league.' },
      DUPLICATE_TEAM_NAME: { code: 409, msg: 'A franchise with this name already exists in this league. Choose a unique name.' },
      LEAGUE_CANCELLED: { code: 409, msg: 'This league has been closed by the owner.' },
      LEAGUE_ALREADY_STARTED: { code: 409, msg: 'Auction has already started for this league.' },
      LEAGUE_FULL: { code: 409, msg: 'This league has reached its maximum participant capacity.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 500).json({ error: hit?.msg ?? 'Failed to join league.' });
  }
});

apiRouter.post('/leagues/:id/join-public', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    teamName: z.string().min(2).max(40),
    teamShortName: z.string().min(2).max(4),
    teamLogoUrl: optionalLogoUrlSchema,
    teamPrimaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Valid franchise name and short tag required' });

  try {
    const result = await joinPublicLeagueById(
      req.dbUser!.id,
      String(req.params.id),
      parsed.data.teamName,
      parsed.data.teamShortName,
      parsed.data.teamLogoUrl,
      parsed.data.teamPrimaryColor
    );
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      PRIVATE_LEAGUE_REQUIRES_INVITE: { code: 403, msg: 'Private leagues require an invitation code or approval.' },
      ALREADY_MEMBER: { code: 409, msg: 'You are already a member of this league.' },
      DUPLICATE_TEAM_NAME: { code: 409, msg: 'A franchise with this name already exists in this league. Choose a unique name.' },
      LEAGUE_CANCELLED: { code: 409, msg: 'This league has been closed.' },
      LEAGUE_ALREADY_STARTED: { code: 409, msg: 'Auction has already started for this league.' },
      LEAGUE_FULL: { code: 409, msg: 'This league is already full.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 500).json({ error: hit?.msg ?? 'Failed to join league.' });
  }
});

apiRouter.post('/leagues/:id/request-join', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const result = await requestToJoinLeague(req.dbUser!.id, String(req.params.id));
    res.status(201).json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      LEAGUE_NOT_JOINABLE: { code: 409, msg: 'This league is not accepting join requests.' },
      ALREADY_MEMBER: { code: 409, msg: 'You are already a member of this league.' },
      LEAGUE_FULL: { code: 409, msg: 'This league is full.' },
      REQUEST_ALREADY_PENDING: { code: 409, msg: 'You already have a pending join request.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 500).json({ error: hit?.msg ?? 'Failed to send join request.' });
  }
});

apiRouter.get('/leagues/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const details = await getLeagueDetails(String(req.params.id), req.dbUser!.id);
    if (!details) return res.status(404).json({ error: 'League not found.' });
    res.json(details);
  } catch (error) {
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Access denied to private league.' });
    }
    res.status(500).json({ error: 'Failed to load league.' });
  }
});

const updateSettingsSchema = z.object({
  name: z.string().min(3).max(60).optional(),
  description: z.string().max(300).optional(),
  logoUrl: optionalLogoUrlSchema,
  visibility: z.enum(['PRIVATE', 'PUBLIC']).optional(),
  maxTeams: z.number().int().min(2).max(12).optional(),
  numberOfTeams: z.number().int().min(2).max(12).optional(),
  purseAmount: z.number().int().min(1000).max(100000).optional(),
  minBasePrice: z.number().int().min(10).max(2000).optional(),
  minSquadSize: z.number().int().min(11).max(25).optional(),
  maxSquadSize: z.number().int().min(11).max(25).optional(),
  bidIncrement: z.number().int().min(5).max(500).optional(),
  timerSeconds: z.number().int().min(5).max(60).optional(),
  auctionMode: z.enum(['MEGA', 'MINI', 'FAST_TRACK']).optional(),
  allowTeamCustomization: z.boolean().optional(),
  minBatsmen: z.number().int().min(0).max(10).optional(),
  minBowlers: z.number().int().min(0).max(10).optional(),
  minAllRounders: z.number().int().min(0).max(10).optional(),
  minWicketkeepers: z.number().int().min(0).max(5).optional(),
  maxOverseas: z.number().int().min(0).max(12).optional(),
});

apiRouter.patch('/leagues/:id/settings', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid settings update', details: parsed.error.flatten() });
  }
  try {
    const updated = await updateLeagueSettings(req.dbUser!.id, String(req.params.id), parsed.data);
    res.json(updated);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      FORBIDDEN_OWNER_ONLY: { code: 403, msg: 'Only the league owner can edit league settings.' },
      CANNOT_EDIT_AFTER_AUCTION_START: { code: 409, msg: 'Settings cannot be changed after auction starts.' },
      MAX_TEAMS_BELOW_MEMBER_COUNT: { code: 400, msg: 'Max capacity cannot be lower than current participants.' },
      INVALID_SQUAD_RANGE: { code: 400, msg: 'Max squad size must be >= min squad size.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 500).json({ error: hit?.msg ?? 'Failed to update league settings.' });
  }
});

apiRouter.patch('/leagues/:id/team', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    teamName: z.string().min(2).max(40),
    shortName: z.string().min(2).max(4),
    logoUrl: optionalLogoUrlSchema,
    primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid franchise name or tag.' });

  try {
    const team = await customizeMyTeam(req.dbUser!.id, String(req.params.id), parsed.data);
    res.json({ team });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      CANNOT_EDIT_AFTER_AUCTION_START: { code: 409, msg: 'Team customization locks once auction begins.' },
      TEAM_CUSTOMIZATION_DISABLED: { code: 403, msg: 'League owner disabled team customization.' },
      NOT_A_MEMBER: { code: 403, msg: 'You do not own a team in this league.' },
      DUPLICATE_TEAM_NAME: { code: 409, msg: 'A franchise with this name already exists in this league. Choose another name.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 500).json({ error: hit?.msg ?? 'Failed to customize team.' });
  }
});

apiRouter.post('/leagues/:id/ready', requireAuth, async (req: AuthRequest, res: Response) => {
  const schema = z.object({ isReady: z.boolean() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'isReady boolean required' });

  try {
    const updated = await toggleReadyStatus(req.dbUser!.id, String(req.params.id), parsed.data.isReady);
    res.json({ member: updated });
  } catch {
    res.status(403).json({ error: 'Not a member of this league.' });
  }
});

apiRouter.post('/leagues/:id/league-ready', requireAuth, async (req: AuthRequest, res: Response) => {
  const schema = z.object({ ready: z.boolean() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'ready boolean required' });

  try {
    const league = await markLeagueReady(req.dbUser!.id, String(req.params.id), parsed.data.ready);
    res.json({ league });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      FORBIDDEN_OWNER_ONLY: { code: 403, msg: 'Only the league owner can change league readiness.' },
      CANNOT_EDIT_AFTER_AUCTION_START: { code: 409, msg: 'Auction has already started.' },
      MIN_TWO_TEAMS_REQUIRED: { code: 400, msg: 'At least 2 participants are required before marking READY.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 500).json({ error: hit?.msg ?? 'Failed to update league readiness.' });
  }
});

apiRouter.post('/leagues/:id/invite', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    targetUserId: z.string().uuid().optional(),
    uniquePlayerId: z.string().min(4).max(20).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success || (!parsed.data.targetUserId && !parsed.data.uniquePlayerId)) {
    return res.status(400).json({ error: 'Provide a targetUserId or CricketVerse Player ID.' });
  }

  try {
    const result = await inviteFriendToLeague(req.dbUser!.id, String(req.params.id), parsed.data);
    res.status(201).json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      LEAGUE_NOT_JOINABLE: { code: 409, msg: 'League is no longer accepting invitations.' },
      FORBIDDEN: { code: 403, msg: 'Only league members can send invitations.' },
      LEAGUE_FULL: { code: 409, msg: 'League is already at full capacity.' },
      PLAYER_NOT_FOUND: { code: 404, msg: 'No player found with that CricketVerse Player ID.' },
      CANNOT_INVITE_SELF: { code: 400, msg: 'You cannot invite yourself.' },
      ALREADY_MEMBER: { code: 409, msg: 'This player is already a member of the league.' },
      INVITE_ALREADY_PENDING: { code: 409, msg: 'An invitation is already pending for this player.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 400).json({ error: hit?.msg ?? 'Failed to send invite.' });
  }
});

apiRouter.post(
  '/leagues/invitations/:invitationId/respond',
  requireAuth,
  writeLimiter,
  async (req: AuthRequest, res: Response) => {
    const schema = z.object({
      action: z.enum(['ACCEPT', 'REJECT', 'REVOKE']),
      teamName: z.string().min(2).max(40).optional(),
      teamShortName: z.string().min(2).max(4).optional(),
      teamLogoUrl: optionalLogoUrlSchema,
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid invitation response payload' });

    try {
      const result = await respondToLeagueInvitation(
        req.dbUser!.id,
        String(req.params.invitationId),
        parsed.data.action,
        parsed.data.teamName,
        parsed.data.teamShortName,
        parsed.data.teamLogoUrl
      );
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'ERROR';
      const map: Record<string, { code: number; msg: string }> = {
        INVITATION_NOT_FOUND: { code: 404, msg: 'Invitation not found.' },
        INVITATION_NOT_PENDING: { code: 409, msg: 'This invitation has already been processed.' },
        INVITE_EXPIRED: { code: 410, msg: 'This invitation has expired.' },
        FORBIDDEN: { code: 403, msg: 'Not authorized to respond to this invitation.' },
        FORBIDDEN_OWNER_ONLY: { code: 403, msg: 'Only the league owner can approve join requests.' },
        ALREADY_MEMBER: { code: 409, msg: 'Already a member of this league.' },
        LEAGUE_FULL: { code: 409, msg: 'League has reached full capacity.' },
        LEAGUE_ALREADY_STARTED: { code: 409, msg: 'Auction has already started.' },
        LEAGUE_CANCELLED: { code: 409, msg: 'League was cancelled.' },
      };
      const hit = map[msg];
      res.status(hit?.code ?? 400).json({ error: hit?.msg ?? 'Failed to process invitation.' });
    }
  }
);

apiRouter.post('/leagues/:id/invite-code/regenerate', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const schema = z.object({ expiresInHours: z.number().int().min(1).max(720).nullable().optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid expiration value' });

  try {
    const league = await regenerateInviteCode(req.dbUser!.id, String(req.params.id), parsed.data.expiresInHours);
    res.json({ league });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    res.status(msg === 'FORBIDDEN_OWNER_ONLY' ? 403 : 400).json({ error: msg });
  }
});

apiRouter.post('/leagues/:id/invite-code/revoke', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const league = await revokeInviteCode(req.dbUser!.id, String(req.params.id));
    res.json({ league });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    res.status(msg === 'FORBIDDEN_OWNER_ONLY' ? 403 : 400).json({ error: msg });
  }
});

apiRouter.post('/leagues/:id/transfer-ownership', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const schema = z.object({ newOwnerUserId: z.string().uuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Valid newOwnerUserId required' });

  try {
    const result = await transferLeagueOwnership(req.dbUser!.id, String(req.params.id), parsed.data.newOwnerUserId);
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      FORBIDDEN_OWNER_ONLY: { code: 403, msg: 'Only the current owner can transfer ownership.' },
      CANNOT_EDIT_AFTER_AUCTION_START: { code: 409, msg: 'Cannot transfer ownership after auction starts.' },
      ALREADY_OWNER: { code: 400, msg: 'You are already the owner.' },
      TARGET_NOT_MEMBER: { code: 404, msg: 'Target player is not a member of this league.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 400).json({ error: hit?.msg ?? 'Failed to transfer ownership.' });
  }
});

apiRouter.delete('/leagues/:id/members/:memberUserId', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const result = await removeMemberFromLeague(
      req.dbUser!.id,
      String(req.params.id),
      String(req.params.memberUserId)
    );
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      FORBIDDEN_OWNER_ONLY: { code: 403, msg: 'Only the league owner can remove members.' },
      CANNOT_EDIT_AFTER_AUCTION_START: { code: 409, msg: 'Members cannot be removed after auction starts.' },
      CANNOT_REMOVE_OWNER: { code: 400, msg: 'Owner cannot be removed.' },
      MEMBER_NOT_FOUND: { code: 404, msg: 'Member not found in league.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 400).json({ error: hit?.msg ?? 'Failed to remove member.' });
  }
});

apiRouter.post('/leagues/:id/leave', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const result = await leaveLeague(req.dbUser!.id, String(req.params.id));
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      OWNER_MUST_TRANSFER_BEFORE_LEAVING: { code: 400, msg: 'Transfer ownership or cancel the league before leaving.' },
      CANNOT_LEAVE_AFTER_AUCTION_START: { code: 409, msg: 'Cannot leave a league after auction begins.' },
      NOT_A_MEMBER: { code: 404, msg: 'You are not a member of this league.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 400).json({ error: hit?.msg ?? 'Failed to leave league.' });
  }
});

apiRouter.post('/leagues/:id/cancel', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const league = await cancelLeague(req.dbUser!.id, String(req.params.id));
    res.json({ league });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      FORBIDDEN_OWNER_ONLY: { code: 403, msg: 'Only the league owner can close or cancel the league.' },
      CANNOT_CANCEL_AFTER_AUCTION_START: { code: 409, msg: 'Cannot cancel a league once auction has started.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 400).json({ error: hit?.msg ?? 'Failed to cancel league.' });
  }
});

// Players Database & Admin Management
apiRouter.get('/players', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const isAdminUser = req.dbUser?.role === 'ADMIN' || req.dbUser?.role === 'OWNER';
    const minRatingRaw = req.query.minRating !== undefined ? Number(req.query.minRating) : undefined;
    const maxRatingRaw = req.query.maxRating !== undefined ? Number(req.query.maxRating) : undefined;
    const sortByRaw = req.query.sortBy ? String(req.query.sortBy) : 'overallRating';
    const sortDirRaw = req.query.sortDir ? String(req.query.sortDir) : 'desc';

    const list = await listFilteredPlayers({
      q: req.query.q ? String(req.query.q) : undefined,
      tab: req.query.tab ? String(req.query.tab) : undefined,
      role: req.query.role ? String(req.query.role) : undefined,
      category: req.query.category ? String(req.query.category) : undefined,
      nationalityCategory: req.query.nationalityCategory ? String(req.query.nationalityCategory) : undefined,
      experienceLevel: req.query.experienceLevel ? String(req.query.experienceLevel) : undefined,
      minRating: Number.isFinite(minRatingRaw) ? minRatingRaw : undefined,
      maxRating: Number.isFinite(maxRatingRaw) ? maxRatingRaw : undefined,
      availability: req.query.availability ? String(req.query.availability) : undefined,
      includeInactive: isAdminUser && req.query.includeInactive === 'true',
      sortBy: sortByRaw === 'basePrice' || sortByRaw === 'name' ? sortByRaw : 'overallRating',
      sortDir: sortDirRaw === 'asc' ? 'asc' : 'desc',
    });

    res.json({ players: list, total: list.length });
  } catch (error) {
    logEvent('ERROR', 'API', 'GET /players failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to fetch player pool.' });
  }
});

apiRouter.get('/players/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const detail = await getPlayerDetailById(String(req.params.id));
    if (!detail) return res.status(404).json({ error: 'Player not found.' });
    res.json(detail);
  } catch (error) {
    logEvent('ERROR', 'API', 'GET /players/:id failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to load player profile.' });
  }
});

const playingRoleEnum = z.enum([
  'BATSMAN',
  'OPENING_BATSMAN',
  'MIDDLE_ORDER_BATSMAN',
  'ALL_ROUNDER',
  'FAST_BOWLER',
  'SPIN_BOWLER',
  'BOWLER',
  'WICKETKEEPER',
]);

const experienceLevelEnum = z.enum(['EMERGING', 'PROFESSIONAL', 'EXPERIENCED', 'ELITE']);
const availabilityStatusEnum = z.enum(['AVAILABLE', 'INJURED', 'INACTIVE']);

const adminAvatarUrlSchema = z
  .string()
  .max(400000)
  .refine(
    (val) =>
      val === '' ||
      val.startsWith('https://') ||
      val.startsWith('http://') ||
      val.startsWith('/src/assets/') ||
      val.startsWith('data:image/'),
    'Avatar must be a valid HTTP(S) URL, built-in asset path, or uploaded image data URL'
  )
  .nullable()
  .optional();

const attributes10Schema = z.object({
  batting: z.number().int().min(0).max(100),
  battingTiming: z.number().int().min(0).max(100),
  powerHitting: z.number().int().min(0).max(100),
  bowling: z.number().int().min(0).max(100),
  bowlingAccuracy: z.number().int().min(0).max(100),
  swing: z.number().int().min(0).max(100),
  spin: z.number().int().min(0).max(100),
  fielding: z.number().int().min(0).max(100),
  stamina: z.number().int().min(0).max(100),
  experience: z.number().int().min(0).max(100),
});

const createAdminPlayerSchema = z.object({
  playerCode: z.string().min(3).max(20).optional(),
  name: z.string().min(2).max(60),
  imageUrl: adminAvatarUrlSchema,
  age: z.number().int().min(16).max(48),
  nationality: z.string().min(2).max(40),
  isOverseas: z.boolean(),
  role: playingRoleEnum,
  battingStyle: z.string().min(2).max(50),
  bowlingStyle: z.string().min(2).max(50),
  attributes: attributes10Schema,
  consistencyRating: z.number().int().min(0).max(100).optional(),
  experienceLevel: experienceLevelEnum.optional(),
  availabilityStatus: availabilityStatusEnum.optional(),
  isActive: z.boolean().optional(),
  demandScore: z.number().int().min(70).max(140).optional(),
  basePrice: z.number().int().min(10).max(2000).optional(),
  category: z.enum(['MARQUEE', 'CAPS', 'DOMESTIC', 'EMERGING']).optional(),
});

apiRouter.post('/admin/players', requireAuth, requireAdmin, writeLimiter, async (req: AuthRequest, res: Response) => {
  const parsed = createAdminPlayerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid player payload', details: parsed.error.flatten() });
  }

  try {
    const result = await createAdminPlayer(req.dbUser!.id, parsed.data);
    res.status(201).json(result);
  } catch (error) {
    logEvent('ERROR', 'API', 'POST /admin/players failed', { error: String(error) });
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to create player.' });
  }
});

const updateAdminPlayerSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  imageUrl: adminAvatarUrlSchema,
  age: z.number().int().min(16).max(48).optional(),
  nationality: z.string().min(2).max(40).optional(),
  isOverseas: z.boolean().optional(),
  role: playingRoleEnum.optional(),
  battingStyle: z.string().min(2).max(50).optional(),
  bowlingStyle: z.string().min(2).max(50).optional(),
  attributes: attributes10Schema.partial().optional(),
  consistencyRating: z.number().int().min(0).max(100).optional(),
  experienceLevel: experienceLevelEnum.optional(),
  availabilityStatus: availabilityStatusEnum.optional(),
  isActive: z.boolean().optional(),
  demandScore: z.number().int().min(70).max(140).optional(),
  basePrice: z.number().int().min(10).max(2000).optional(),
  recalculatePrice: z.boolean().optional(),
  category: z.enum(['MARQUEE', 'CAPS', 'DOMESTIC', 'EMERGING']).optional(),
});

apiRouter.patch('/admin/players/:id', requireAuth, requireAdmin, writeLimiter, async (req: AuthRequest, res: Response) => {
  const parsed = updateAdminPlayerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid player update payload', details: parsed.error.flatten() });
  }

  try {
    const updated = await updateAdminPlayer(req.dbUser!.id, String(req.params.id), parsed.data);
    res.json({ player: updated });
  } catch (error) {
    if (error instanceof Error && error.message === 'PLAYER_NOT_FOUND') {
      return res.status(404).json({ error: 'Player not found.' });
    }
    res.status(400).json({ error: 'Failed to update player.' });
  }
});

const importPlayersSchema = z.object({
  players: z
    .array(
      z.object({
        playerCode: z.string().min(3).max(20).optional(),
        name: z.string().min(2).max(60),
        imageUrl: adminAvatarUrlSchema,
        age: z.number().int().min(16).max(48),
        nationality: z.string().min(2).max(40),
        isOverseas: z.boolean(),
        role: playingRoleEnum,
        battingStyle: z.string().min(2).max(50),
        bowlingStyle: z.string().min(2).max(50),
        battingRating: z.number().int().min(0).max(100),
        battingTiming: z.number().int().min(0).max(100).optional(),
        powerHitting: z.number().int().min(0).max(100).optional(),
        bowlingRating: z.number().int().min(0).max(100),
        bowlingAccuracy: z.number().int().min(0).max(100).optional(),
        swing: z.number().int().min(0).max(100).optional(),
        spin: z.number().int().min(0).max(100).optional(),
        fieldingRating: z.number().int().min(0).max(100),
        stamina: z.number().int().min(0).max(100).optional(),
        consistencyRating: z.number().int().min(0).max(100).optional(),
        experienceRating: z.number().int().min(0).max(100),
        experienceLevel: experienceLevelEnum.optional(),
        availabilityStatus: availabilityStatusEnum.optional(),
        basePrice: z.number().int().min(10).max(2000).optional(),
        category: z.enum(['MARQUEE', 'CAPS', 'DOMESTIC', 'EMERGING']).optional(),
      })
    )
    .min(1)
    .max(200),
});

apiRouter.post('/admin/players/import', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const parsed = importPlayersSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid player import payload', details: parsed.error.flatten() });
  }

  try {
    const inserted = await importAdminPlayers(req.dbUser!.id, parsed.data.players);
    res.status(201).json({ importedCount: inserted.length, players: inserted });
  } catch (error) {
    logEvent('ERROR', 'API', 'POST /admin/players/import failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to import players.' });
  }
});

// Auction REST API (Backed by exact same transactional AuctionEngine as Socket.IO)
apiRouter.get('/auctions', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const dashboard = await listAuctionDashboard(req.dbUser!.id);
    res.json(dashboard);
  } catch (error) {
    logEvent('ERROR', 'API', 'GET /auctions failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to load auctions dashboard.' });
  }
});

const auctionConfigSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  purseAmount: z.number().int().min(500).max(100000).optional(),
  minSquadSize: z.number().int().min(1).max(25).optional(),
  maxSquadSize: z.number().int().min(1).max(25).optional(),
  maxOverseas: z.number().int().min(0).max(12).optional(),
  minBatsmen: z.number().int().min(0).max(10).optional(),
  minBowlers: z.number().int().min(0).max(10).optional(),
  minAllRounders: z.number().int().min(0).max(10).optional(),
  minWicketkeepers: z.number().int().min(0).max(5).optional(),
  bidIncrement: z.number().int().min(1).max(500).optional(),
  useTieredIncrements: z.boolean().optional(),
  tier1Increment: z.number().int().min(1).max(200).optional(),
  tier2Increment: z.number().int().min(1).max(500).optional(),
  tier3Increment: z.number().int().min(1).max(1000).optional(),
  timerSeconds: z.number().int().min(5).max(120).optional(),
  maxTimerExtensions: z.number().int().min(0).max(100).nullable().optional(),
  playerOrderMode: z.enum(['RANDOM', 'ROLE_BASED', 'ADMIN_DEFINED', 'MANUAL']).optional(),
  manualPlayerIds: z.array(z.string().uuid()).max(200).nullable().optional(),
  basePriceOverrides: z.record(z.string(), z.number().int().positive()).nullable().optional(),
  playerPoolLimit: z.number().int().min(1).max(300).nullable().optional(),
  enableSecondRound: z.boolean().optional(),
  allowSkipPlayer: z.boolean().optional(),
  scheduledStartAt: z.string().datetime().nullable().optional(),
  auctionMode: z.enum(['MEGA', 'MINI', 'FAST_TRACK']).optional(),
});

const createAuctionRoomSchema = auctionConfigSchema.extend({
  leagueId: z.string().uuid().optional(),
  leagueName: z.string().min(3).max(60).optional(),
  visibility: z.enum(['PRIVATE', 'PUBLIC']).optional(),
  maxTeams: z.number().int().min(2).max(12).optional(),
  teamName: z.string().min(2).max(40).optional(),
  teamShortName: z.string().min(2).max(4).optional(),
});

apiRouter.post('/auctions', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const parsed = createAuctionRoomSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid auction creation payload', details: parsed.error.flatten() });
  }

  try {
    let targetLeagueId = parsed.data.leagueId;
    if (!targetLeagueId) {
      const leagueName = parsed.data.leagueName || parsed.data.name || 'CricketVerse Auction League';
      const created = await createLeague(req.dbUser!.id, {
        name: leagueName,
        visibility: parsed.data.visibility ?? 'PUBLIC',
        maxTeams: parsed.data.maxTeams ?? 8,
        purseAmount: parsed.data.purseAmount ?? 10000,
        minSquadSize: parsed.data.minSquadSize ?? 15,
        maxSquadSize: parsed.data.maxSquadSize ?? 25,
        bidIncrement: parsed.data.bidIncrement ?? 10,
        timerSeconds: parsed.data.timerSeconds ?? 20,
        auctionMode: parsed.data.auctionMode ?? 'MEGA',
        teamName: parsed.data.teamName || `${req.dbUser!.profile?.displayName || 'Host'} XI`,
        teamShortName: (parsed.data.teamShortName || 'HST').toUpperCase().slice(0, 4),
        settings: {
          maxOverseas: parsed.data.maxOverseas ?? 8,
          minBatsmen: parsed.data.minBatsmen ?? 4,
          minBowlers: parsed.data.minBowlers ?? 4,
          minAllRounders: parsed.data.minAllRounders ?? 2,
          minWicketkeepers: parsed.data.minWicketkeepers ?? 1,
        },
      });
      targetLeagueId = created.league.id;
    }

    const snapshot = await configureAuction(targetLeagueId, req.dbUser!.id, parsed.data);
    res.status(201).json(snapshot);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const status = msg === 'FORBIDDEN_OWNER_ONLY' ? 403 : msg === 'AUCTION_SETTINGS_LOCKED' ? 409 : 400;
    res.status(status).json({ error: msg });
  }
});

apiRouter.get('/auctions/:leagueId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const snapshot = await getAuctionSnapshot(String(req.params.leagueId));
    if (!snapshot) return res.status(404).json({ error: 'Auction not found.' });
    res.json(snapshot);
  } catch {
    res.status(500).json({ error: 'Failed to fetch auction state.' });
  }
});

apiRouter.patch('/auctions/:leagueId/config', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const parsed = auctionConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid auction configuration', details: parsed.error.flatten() });
  }

  try {
    const snapshot = await configureAuction(String(req.params.leagueId), req.dbUser!.id, parsed.data);
    res.json(snapshot);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      AUCTION_NOT_FOUND: { code: 404, msg: 'Auction not found.' },
      FORBIDDEN_OWNER_ONLY: { code: 403, msg: 'Only the league owner can configure auction settings.' },
      AUCTION_SETTINGS_LOCKED: { code: 409, msg: 'Auction settings are locked once the auction starts.' },
      INVALID_SQUAD_RANGE: { code: 400, msg: 'Max squad size must be >= min squad size (1..25).' },
      INVALID_PURSE_AMOUNT: { code: 400, msg: 'Virtual purse must be a positive integer (500..100000 Lakhs).' },
      INVALID_TIMER_SECONDS: { code: 400, msg: 'Auction countdown must be between 5 and 120 seconds.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 400).json({ error: hit?.msg ?? msg });
  }
});

apiRouter.get('/auctions/:leagueId/history', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const snapshot = await getAuctionSnapshot(String(req.params.leagueId));
    if (!snapshot) return res.status(404).json({ error: 'Auction not found.' });
    res.json({
      leagueId: snapshot.league.id,
      auctionState: snapshot.auction.state,
      history: snapshot.history,
      bids: snapshot.bids,
      events: snapshot.recentEvents,
    });
  } catch {
    res.status(500).json({ error: 'Failed to load auction history.' });
  }
});

apiRouter.post('/auctions/:leagueId/start', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await ensurePlayersSeeded();
    const snapshot = await startAuction(String(req.params.leagueId), req.dbUser!.id, {
      requireAllReady: true,
    });
    res.json(snapshot);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      ONLY_OWNER_CAN_START: { code: 403, msg: 'Only the league host can start the auction.' },
      LEAGUE_CANCELLED: { code: 409, msg: 'This league was cancelled by the owner.' },
      AUCTION_ALREADY_STARTED: { code: 409, msg: 'Auction has already been started.' },
      MIN_TWO_TEAMS_REQUIRED: { code: 400, msg: 'At least 2 teams must join before starting.' },
      PARTICIPANTS_NOT_READY: {
        code: 400,
        msg: 'All joined franchise owners must mark themselves Ready before starting the auction.',
      },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 500).json({ error: hit?.msg ?? 'Failed to start auction.' });
  }
});

apiRouter.post('/auctions/:leagueId/bid', requireAuth, bidLimiter, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    amount: z.number().int().positive(),
    idempotencyKey: z.string().min(4).max(120).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Valid positive integer bid amount required' });

  try {
    const result = await placeBid({
      leagueId: String(req.params.leagueId),
      userId: req.dbUser!.id,
      amount: parsed.data.amount,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'BID_REJECTED';
    if (msg.startsWith('MIN_BID_REQUIRED:')) {
      return res.status(400).json({ error: `Minimum valid bid is ${msg.split(':')[1]} L.` });
    }
    const map: Record<string, { code: number; msg: string }> = {
      NOT_LEAGUE_MEMBER: { code: 403, msg: 'Only league members can place bids.' },
      AUCTION_NOT_ACCEPTING_BIDS: { code: 409, msg: 'Auction is not currently accepting bids.' },
      LOT_TIMER_EXPIRED: { code: 409, msg: 'Lot countdown expired.' },
      ALREADY_HIGHEST_BIDDER: { code: 400, msg: 'You already hold the highest bid.' },
      PLAYER_ALREADY_OWNED_IN_LEAGUE: { code: 409, msg: 'Player is already owned in this league.' },
      SQUAD_LIMIT_REACHED: { code: 400, msg: 'Your franchise has reached its maximum squad limit.' },
      OVERSEAS_LIMIT_REACHED: { code: 400, msg: 'Overseas player limit reached for your franchise.' },
      INSUFFICIENT_PURSE: { code: 400, msg: 'Bid exceeds your remaining virtual purse.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 400).json({ error: hit?.msg ?? msg });
  }
});

apiRouter.post('/auctions/:leagueId/pause', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const snapshot = await pauseAuction(String(req.params.leagueId), req.dbUser!.id);
    res.json(snapshot);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to pause auction.' });
  }
});

apiRouter.post('/auctions/:leagueId/resume', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const snapshot = await resumeAuction(String(req.params.leagueId), req.dbUser!.id);
    res.json(snapshot);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to resume auction.' });
  }
});

apiRouter.post('/auctions/:leagueId/skip', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const snapshot = await skipCurrentLot(String(req.params.leagueId), req.dbUser!.id);
    res.json(snapshot);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to skip player.';
    const map: Record<string, string> = {
      ONLY_OWNER_CAN_CONTROL: 'Only the league owner can skip players.',
      SKIP_PLAYER_DISABLED: 'Skipping players is disabled in this auction configuration.',
      CANNOT_SKIP_ACTIVE_BIDDING: 'Cannot skip a player once valid bids have been placed.',
    };
    res.status(msg === 'ONLY_OWNER_CAN_CONTROL' ? 403 : 400).json({ error: map[msg] ?? msg });
  }
});

apiRouter.post('/auctions/:leagueId/unsold-round', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const snapshot = await startUnsoldRound(String(req.params.leagueId), req.dbUser!.id);
    res.json(snapshot);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to start unsold round.';
    res.status(msg === 'ONLY_OWNER_CAN_CONTROL' ? 403 : 400).json({ error: msg });
  }
});

apiRouter.post('/auctions/:leagueId/end', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const force = Boolean((req.body as { force?: boolean } | undefined)?.force);
    const snapshot = await endAuction(String(req.params.leagueId), req.dbUser!.id, force);
    res.json(snapshot);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to end auction.';
    res.status(msg === 'ONLY_OWNER_CAN_CONTROL' ? 403 : 400).json({ error: msg });
  }
});

apiRouter.post('/auctions/:leagueId/cancel', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const snapshot = await cancelAuction(String(req.params.leagueId), req.dbUser!.id);
    res.json(snapshot);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to cancel auction.';
    res.status(msg === 'ONLY_OWNER_CAN_CONTROL' ? 403 : 400).json({ error: msg });
  }
});

apiRouter.post('/auctions/:leagueId/finalize-lot', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const details = await getLeagueDetails(String(req.params.leagueId), req.dbUser!.id);
    if (!details || (details.league.ownerId !== req.dbUser!.id && req.dbUser!.role !== 'ADMIN')) {
      return res.status(403).json({ error: 'Only the league host can force-close a lot.' });
    }
    const snapshot = await finalizeCurrentLot(String(req.params.leagueId), true);
    res.json(snapshot);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to finalize lot.' });
  }
});

// Teams & Squad Management
apiRouter.get('/teams/mine', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const myTeams = await getUserTeams(req.dbUser!.id);
    res.json({ teams: myTeams });
  } catch {
    res.status(500).json({ error: 'Failed to load teams.' });
  }
});

apiRouter.get('/teams/:teamId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const data = await getTeamWithRoster(String(req.params.teamId));
    if (!data) return res.status(404).json({ error: 'Team not found.' });
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Failed to load team roster.' });
  }
});

const acquirePlayerSchema = z.object({
  leagueId: z.string().uuid(),
  playerId: z.string().uuid(),
  purchasePrice: z.number().int().positive(),
});

apiRouter.post('/teams/:teamId/acquire', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const parsed = acquirePlayerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid player acquisition payload', details: parsed.error.flatten() });
  }
  try {
    const result = await assignPlayerToTeamInLeague({
      actorUserId: req.dbUser!.id,
      leagueId: parsed.data.leagueId,
      teamId: String(req.params.teamId),
      playerId: parsed.data.playerId,
      purchasePrice: parsed.data.purchasePrice,
      enforceActorOwnership: req.dbUser!.role !== 'ADMIN' && req.dbUser!.role !== 'OWNER',
    });
    res.status(201).json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    const map: Record<string, { code: number; msg: string }> = {
      LEAGUE_NOT_FOUND: { code: 404, msg: 'League not found.' },
      TEAM_NOT_FOUND: { code: 404, msg: 'Franchise team not found in this league.' },
      FORBIDDEN: { code: 403, msg: 'Only the franchise or league owner can assign players.' },
      PLAYER_NOT_FOUND: { code: 404, msg: 'Player not found.' },
      PLAYER_UNAVAILABLE: { code: 400, msg: 'Player is currently inactive/unavailable.' },
      PLAYER_ALREADY_OWNED_IN_LEAGUE: { code: 409, msg: 'Player is already owned by another team in this league.' },
      SQUAD_LIMIT_REACHED: { code: 400, msg: 'Maximum squad size reached for this franchise.' },
      INSUFFICIENT_PURSE: { code: 400, msg: 'Remaining virtual purse is insufficient.' },
      INVALID_PURCHASE_PRICE: { code: 400, msg: 'Purchase price must be a positive integer.' },
    };
    const hit = map[msg];
    res.status(hit?.code ?? 400).json({ error: hit?.msg ?? msg });
  }
});

apiRouter.post('/teams/:teamId/complete', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const result = await markTeamSquadComplete(req.dbUser!.id, String(req.params.teamId));
    res.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    if (msg === 'TEAM_NOT_FOUND') return res.status(404).json({ error: 'Team not found.' });
    if (msg === 'FORBIDDEN') return res.status(403).json({ error: 'Only the team or league owner can mark squad complete.' });
    if (msg.startsWith('SQUAD_RULES_NOT_MET:')) return res.status(400).json({ error: msg });
    res.status(400).json({ error: msg });
  }
});

const updateLineupSchema = z.object({
  teamName: z.string().min(2).max(40).optional(),
  shortName: z.string().min(2).max(4).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  captainPlayerId: z.string().uuid().nullable().optional(),
  viceCaptainPlayerId: z.string().uuid().nullable().optional(),
  wicketkeeperPlayerId: z.string().uuid().nullable().optional(),
  playingXiIds: z.array(z.string().uuid()).max(11),
  bowlingOrderIds: z.array(z.string().uuid()).max(11),
  substituteIds: z.array(z.string().uuid()).max(25).optional(),
  requireFullXi: z.boolean().optional(),
});

apiRouter.put('/teams/:teamId/lineup', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const parsed = updateLineupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid lineup configuration', details: parsed.error.flatten() });
  }

  try {
    const updated = await updateTeamLineup(req.dbUser!.id, String(req.params.teamId), parsed.data);
    res.json(updated);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    if (msg === 'TEAM_NOT_FOUND_OR_FORBIDDEN') {
      return res.status(403).json({ error: 'You do not own this franchise team.' });
    }
    res.status(400).json({ error: msg });
  }
});

// Matches & Tournament Standings
apiRouter.post('/matches/simulate', requireAuth, writeLimiter, async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    homeTeamId: z.string().uuid(),
    awayTeamId: z.string().uuid(),
    mode: z.enum(['AI', '1V1', 'TOURNAMENT']),
    leagueId: z.string().uuid().optional(),
    requireValidXi: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid match parameters' });
  if (parsed.data.homeTeamId === parsed.data.awayTeamId) {
    return res.status(400).json({ error: 'Home and Away teams must be different.' });
  }

  try {
    const result = await simulateQuickMatch(
      parsed.data.homeTeamId,
      parsed.data.awayTeamId,
      parsed.data.mode,
      parsed.data.leagueId,
      { requireValidXi: parsed.data.requireValidXi }
    );
    res.status(201).json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'ERROR';
    if (msg === 'TEAM_NOT_FOUND') {
      return res.status(404).json({ error: 'Selected franchise team was not found.' });
    }
    if (msg.startsWith('PLAYING_XI_INVALID')) {
      return res.status(400).json({ error: msg });
    }
    res.status(500).json({ error: 'Failed to run match simulation.' });
  }
});

apiRouter.get('/leagues/:id/standings', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const data = await getLeagueStandingsAndMatches(String(req.params.id));
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Failed to load standings.' });
  }
});
