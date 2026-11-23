import { desc, eq } from 'drizzle-orm';
import { db } from '../../src/db/index.ts';
import { auditLogs, players, playerSeasons } from '../../src/db/schema.ts';
import { ensurePlayersSeeded } from '../../src/db/seedPlayers.ts';
import {
  AvailabilityStatus,
  calculateOverallRating,
  calculatePlayerValuation,
  clampAttr,
  deriveCategoryFromLevel,
  deriveExperienceLevel,
  ExperienceLevel,
  isAllRounderRole,
  isBatsmanRole,
  isBowlerRole,
  isWicketkeeperRole,
  NationalityCategory,
  PlayerAttributes10,
  PlayingRole,
} from '../../src/lib/cricketEngine.ts';

const PORTRAIT_BY_ROLE: Record<string, string> = {
  BATSMAN: '/src/assets/images/player_batsman_portrait_1794578454251.jpg',
  OPENING_BATSMAN: '/src/assets/images/player_batsman_portrait_1794578454251.jpg',
  MIDDLE_ORDER_BATSMAN: '/src/assets/images/player_batsman_portrait_1794578454251.jpg',
  ALL_ROUNDER: '/src/assets/images/player_batsman_portrait_1794578454251.jpg',
  BOWLER: '/src/assets/images/player_bowler_portrait_1794578454903.jpg',
  FAST_BOWLER: '/src/assets/images/player_bowler_portrait_1794578454903.jpg',
  SPIN_BOWLER: '/src/assets/images/player_bowler_portrait_1794578454903.jpg',
  WICKETKEEPER: '/src/assets/images/player_keeper_portrait_1794578452592.jpg',
};

export interface PlayerQueryFilters {
  q?: string;
  tab?: string; // ALL | BATSMEN | BOWLERS | ALL_ROUNDERS | WICKETKEEPERS | EMERGING | OVERSEAS | ELITE
  role?: string;
  category?: string;
  nationalityCategory?: string; // DOMESTIC | OVERSEAS | ALL
  experienceLevel?: string; // EMERGING | PROFESSIONAL | EXPERIENCED | ELITE | ALL
  minRating?: number;
  maxRating?: number;
  availability?: string;
  includeInactive?: boolean;
  sortBy?: 'basePrice' | 'overallRating' | 'name';
  sortDir?: 'asc' | 'desc';
}

export async function listFilteredPlayers(filters: PlayerQueryFilters = {}) {
  await ensurePlayersSeeded();

  const all = await db.select().from(players).orderBy(desc(players.overallRating));
  const seasons = await db.select().from(playerSeasons);
  const seasonByPlayer = new Map<string, typeof seasons[number]>();
  for (const s of seasons) {
    if (!seasonByPlayer.has(s.playerId)) {
      seasonByPlayer.set(s.playerId, s);
    }
  }

  const qLower = (filters.q || '').trim().toLowerCase();
  const tab = (filters.tab || 'ALL').toUpperCase();
  const roleFilter = (filters.role || 'ALL').toUpperCase();
  const catFilter = (filters.category || 'ALL').toUpperCase();
  const natFilter = (filters.nationalityCategory || 'ALL').toUpperCase();
  const expFilter = (filters.experienceLevel || 'ALL').toUpperCase();
  const availFilter = (filters.availability || 'ALL').toUpperCase();

  let filtered = all.filter((p) => {
    if (!filters.includeInactive && (!p.isActive || p.availabilityStatus === 'INACTIVE')) {
      return false;
    }

    if (tab === 'BATSMEN' && !isBatsmanRole(p.role)) return false;
    if (tab === 'BOWLERS' && !isBowlerRole(p.role)) return false;
    if (tab === 'ALL_ROUNDERS' && !isAllRounderRole(p.role)) return false;
    if (tab === 'WICKETKEEPERS' && !isWicketkeeperRole(p.role)) return false;
    if (tab === 'EMERGING' && p.experienceLevel !== 'EMERGING' && p.category !== 'EMERGING') return false;
    if (tab === 'OVERSEAS' && !p.isOverseas && p.nationalityCategory !== 'OVERSEAS') return false;
    if (tab === 'ELITE' && p.experienceLevel !== 'ELITE' && p.category !== 'MARQUEE') return false;

    if (roleFilter !== 'ALL' && p.role !== roleFilter) return false;
    if (catFilter !== 'ALL' && p.category !== catFilter) return false;
    if (natFilter === 'DOMESTIC' && p.isOverseas) return false;
    if (natFilter === 'OVERSEAS' && !p.isOverseas) return false;
    if (expFilter !== 'ALL' && p.experienceLevel !== expFilter) return false;
    if (availFilter !== 'ALL' && p.availabilityStatus !== availFilter) return false;

    if (typeof filters.minRating === 'number' && p.overallRating < filters.minRating) return false;
    if (typeof filters.maxRating === 'number' && p.overallRating > filters.maxRating) return false;

    if (qLower) {
      const hit =
        p.name.toLowerCase().includes(qLower) ||
        p.playerCode.toLowerCase().includes(qLower) ||
        p.nationality.toLowerCase().includes(qLower) ||
        p.role.toLowerCase().includes(qLower);
      if (!hit) return false;
    }

    return true;
  });

  const sortBy = filters.sortBy || 'overallRating';
  const sortDir = filters.sortDir === 'asc' ? 1 : -1;

  filtered = [...filtered].sort((a, b) => {
    if (sortBy === 'basePrice') {
      const diff = (a.basePrice - b.basePrice) * sortDir;
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    }
    if (sortBy === 'name') {
      return a.name.localeCompare(b.name) * sortDir;
    }
    const diff = (a.overallRating - b.overallRating) * sortDir;
    return diff !== 0 ? diff : (a.basePrice - b.basePrice) * sortDir;
  });

  const enriched = filtered.map((p) => ({
    ...p,
    seasonStats: seasonByPlayer.get(p.id) ?? null,
  }));

  return enriched;
}

export async function getPlayerDetailById(idOrCode: string) {
  await ensurePlayersSeeded();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrCode);

  const [player] = await db
    .select()
    .from(players)
    .where(isUuid ? eq(players.id, idOrCode) : eq(players.playerCode, idOrCode.toUpperCase()))
    .limit(1);

  if (!player) return null;

  const seasons = await db
    .select()
    .from(playerSeasons)
    .where(eq(playerSeasons.playerId, player.id));

  return {
    player,
    seasons,
  };
}

export interface AdminPlayerCreateInput {
  playerCode?: string;
  name: string;
  imageUrl?: string | null;
  age: number;
  nationality: string;
  isOverseas: boolean;
  role: PlayingRole;
  battingStyle: string;
  bowlingStyle: string;
  attributes: PlayerAttributes10;
  consistencyRating?: number;
  experienceLevel?: ExperienceLevel;
  availabilityStatus?: AvailabilityStatus;
  isActive?: boolean;
  demandScore?: number;
  basePrice?: number;
  category?: 'MARQUEE' | 'CAPS' | 'DOMESTIC' | 'EMERGING';
}

async function generateNextPlayerCode(): Promise<string> {
  const existing = await db.select({ playerCode: players.playerCode }).from(players);
  let maxNum = existing.length;
  for (const row of existing) {
    const match = row.playerCode.match(/^CVP-(\d+)$/i);
    if (match) {
      const n = Number(match[1]);
      if (n > maxNum) maxNum = n;
    }
  }
  return `CVP-${String(maxNum + 1).padStart(4, '0')}`;
}

export async function createAdminPlayer(actorUserId: string, input: AdminPlayerCreateInput) {
  await ensurePlayersSeeded();

  const attrs: PlayerAttributes10 = {
    batting: clampAttr(input.attributes.batting),
    battingTiming: clampAttr(input.attributes.battingTiming),
    powerHitting: clampAttr(input.attributes.powerHitting),
    bowling: clampAttr(input.attributes.bowling),
    bowlingAccuracy: clampAttr(input.attributes.bowlingAccuracy),
    swing: clampAttr(input.attributes.swing),
    spin: clampAttr(input.attributes.spin),
    fielding: clampAttr(input.attributes.fielding),
    stamina: clampAttr(input.attributes.stamina),
    experience: clampAttr(input.attributes.experience),
  };

  const experienceLevel = input.experienceLevel ?? deriveExperienceLevel(attrs.experience, input.age);
  const overallRating = calculateOverallRating(input.role, attrs);
  const demandScore = clampAttr(input.demandScore ?? 100);
  const valuation = calculatePlayerValuation({
    role: input.role,
    attributes: attrs,
    experienceLevel,
    isOverseas: input.isOverseas,
    demandScore,
  });

  const playerCode = (input.playerCode?.trim().toUpperCase()) || (await generateNextPlayerCode());
  const nationalityCategory: NationalityCategory = input.isOverseas ? 'OVERSEAS' : 'DOMESTIC';
  const category = input.category ?? deriveCategoryFromLevel(experienceLevel, overallRating);
  const availabilityStatus: AvailabilityStatus = input.availabilityStatus ?? 'AVAILABLE';
  const isActive = input.isActive ?? availabilityStatus !== 'INACTIVE';

  const [created] = await db
    .insert(players)
    .values({
      playerCode,
      name: input.name.trim(),
      imageUrl: input.imageUrl?.trim() || PORTRAIT_BY_ROLE[input.role] || PORTRAIT_BY_ROLE.BATSMAN,
      age: input.age,
      nationality: input.nationality.trim(),
      isOverseas: input.isOverseas,
      nationalityCategory,
      role: input.role,
      battingStyle: input.battingStyle.trim(),
      bowlingStyle: input.bowlingStyle.trim(),
      battingRating: attrs.batting,
      battingTiming: attrs.battingTiming,
      powerHitting: attrs.powerHitting,
      bowlingRating: attrs.bowling,
      bowlingAccuracy: attrs.bowlingAccuracy,
      swing: attrs.swing,
      spin: attrs.spin,
      fieldingRating: attrs.fielding,
      stamina: attrs.stamina,
      consistencyRating: clampAttr(input.consistencyRating ?? Math.round((attrs.battingTiming + attrs.bowlingAccuracy) / 2)),
      experienceRating: attrs.experience,
      overallRating,
      experienceLevel,
      availabilityStatus,
      isActive,
      demandScore,
      valuationBreakdown: valuation,
      basePrice: typeof input.basePrice === 'number' ? Math.round(input.basePrice) : valuation.suggestedBasePrice,
      category,
    })
    .returning();

  const [season] = await db
    .insert(playerSeasons)
    .values({
      playerId: created.id,
      seasonName: 'Premier Series 2026',
      matchesPlayed: 10,
      runs: isBowlerRole(created.role) ? 45 : created.battingRating * 4,
      strikeRate: 128,
      wickets: isBatsmanRole(created.role) || isWicketkeeperRole(created.role) ? 0 : 12,
      economyRate: 740,
      ratingOverall: created.overallRating,
    })
    .returning();

  await db.insert(auditLogs).values({
    actorUserId,
    action: 'ADMIN_PLAYER_CREATED',
    resourceType: 'PLAYER',
    resourceId: created.id,
    details: { playerCode: created.playerCode, name: created.name, basePrice: created.basePrice },
  });

  return { player: created, seasonStats: season };
}

export interface AdminPlayerUpdateInput {
  name?: string;
  imageUrl?: string | null;
  age?: number;
  nationality?: string;
  isOverseas?: boolean;
  role?: PlayingRole;
  battingStyle?: string;
  bowlingStyle?: string;
  attributes?: Partial<PlayerAttributes10>;
  consistencyRating?: number;
  experienceLevel?: ExperienceLevel;
  availabilityStatus?: AvailabilityStatus;
  isActive?: boolean;
  demandScore?: number;
  basePrice?: number;
  recalculatePrice?: boolean;
  category?: 'MARQUEE' | 'CAPS' | 'DOMESTIC' | 'EMERGING';
}

export async function updateAdminPlayer(actorUserId: string, playerId: string, input: AdminPlayerUpdateInput) {
  const [existing] = await db.select().from(players).where(eq(players.id, playerId)).limit(1);
  if (!existing) throw new Error('PLAYER_NOT_FOUND');

  const nextRole = (input.role ?? existing.role) as PlayingRole;
  const nextIsOverseas = input.isOverseas ?? existing.isOverseas;
  const nextAge = input.age ?? existing.age;

  const mergedAttrs: PlayerAttributes10 = {
    batting: clampAttr(input.attributes?.batting ?? existing.battingRating),
    battingTiming: clampAttr(input.attributes?.battingTiming ?? existing.battingTiming),
    powerHitting: clampAttr(input.attributes?.powerHitting ?? existing.powerHitting),
    bowling: clampAttr(input.attributes?.bowling ?? existing.bowlingRating),
    bowlingAccuracy: clampAttr(input.attributes?.bowlingAccuracy ?? existing.bowlingAccuracy),
    swing: clampAttr(input.attributes?.swing ?? existing.swing),
    spin: clampAttr(input.attributes?.spin ?? existing.spin),
    fielding: clampAttr(input.attributes?.fielding ?? existing.fieldingRating),
    stamina: clampAttr(input.attributes?.stamina ?? existing.stamina),
    experience: clampAttr(input.attributes?.experience ?? existing.experienceRating),
  };

  const nextExpLevel: ExperienceLevel =
    input.experienceLevel ?? (existing.experienceLevel as ExperienceLevel) ?? deriveExperienceLevel(mergedAttrs.experience, nextAge);
  const overallRating = calculateOverallRating(nextRole, mergedAttrs);
  const demandScore = Math.max(70, Math.min(140, Math.round(input.demandScore ?? existing.demandScore ?? 100)));

  const valuation = calculatePlayerValuation({
    role: nextRole,
    attributes: mergedAttrs,
    experienceLevel: nextExpLevel,
    isOverseas: nextIsOverseas,
    demandScore,
  });

  const nextAvailability: AvailabilityStatus =
    input.availabilityStatus ??
    (input.isActive === false ? 'INACTIVE' : input.isActive === true && existing.availabilityStatus === 'INACTIVE' ? 'AVAILABLE' : (existing.availabilityStatus as AvailabilityStatus));

  const nextIsActive = input.isActive ?? (nextAvailability !== 'INACTIVE');

  const nextBasePrice =
    typeof input.basePrice === 'number'
      ? Math.round(input.basePrice)
      : input.recalculatePrice
      ? valuation.suggestedBasePrice
      : existing.basePrice;

  const [updated] = await db
    .update(players)
    .set({
      name: input.name?.trim() || existing.name,
      imageUrl: input.imageUrl !== undefined ? (input.imageUrl || PORTRAIT_BY_ROLE[nextRole] || existing.imageUrl) : existing.imageUrl,
      age: nextAge,
      nationality: input.nationality?.trim() || existing.nationality,
      isOverseas: nextIsOverseas,
      nationalityCategory: nextIsOverseas ? 'OVERSEAS' : 'DOMESTIC',
      role: nextRole,
      battingStyle: input.battingStyle?.trim() || existing.battingStyle,
      bowlingStyle: input.bowlingStyle?.trim() || existing.bowlingStyle,
      battingRating: mergedAttrs.batting,
      battingTiming: mergedAttrs.battingTiming,
      powerHitting: mergedAttrs.powerHitting,
      bowlingRating: mergedAttrs.bowling,
      bowlingAccuracy: mergedAttrs.bowlingAccuracy,
      swing: mergedAttrs.swing,
      spin: mergedAttrs.spin,
      fieldingRating: mergedAttrs.fielding,
      stamina: mergedAttrs.stamina,
      consistencyRating: input.consistencyRating !== undefined ? clampAttr(input.consistencyRating) : existing.consistencyRating,
      experienceRating: mergedAttrs.experience,
      overallRating,
      experienceLevel: nextExpLevel,
      availabilityStatus: nextAvailability,
      isActive: nextIsActive,
      demandScore,
      valuationBreakdown: valuation,
      basePrice: nextBasePrice,
      category: input.category ?? deriveCategoryFromLevel(nextExpLevel, overallRating),
      updatedAt: new Date(),
    })
    .where(eq(players.id, playerId))
    .returning();

  await db
    .update(playerSeasons)
    .set({ ratingOverall: overallRating })
    .where(eq(playerSeasons.playerId, playerId));

  await db.insert(auditLogs).values({
    actorUserId,
    action: 'ADMIN_PLAYER_UPDATED',
    resourceType: 'PLAYER',
    resourceId: playerId,
    details: { playerCode: updated.playerCode, overallRating, basePrice: updated.basePrice, isActive: updated.isActive },
  });

  return updated;
}

export async function importAdminPlayers(
  actorUserId: string,
  items: Array<{
    playerCode?: string;
    name: string;
    imageUrl?: string | null;
    age: number;
    nationality: string;
    isOverseas: boolean;
    role: PlayingRole;
    battingStyle: string;
    bowlingStyle: string;
    battingRating: number;
    battingTiming?: number;
    powerHitting?: number;
    bowlingRating: number;
    bowlingAccuracy?: number;
    swing?: number;
    spin?: number;
    fieldingRating: number;
    stamina?: number;
    consistencyRating?: number;
    experienceRating: number;
    experienceLevel?: ExperienceLevel;
    availabilityStatus?: AvailabilityStatus;
    basePrice?: number;
    category?: 'MARQUEE' | 'CAPS' | 'DOMESTIC' | 'EMERGING';
  }>
) {
  await ensurePlayersSeeded();

  let seq = 1000;
  const existing = await db.select({ playerCode: players.playerCode }).from(players);
  for (const row of existing) {
    const match = row.playerCode.match(/^CVP-(\d+)$/i);
    if (match && Number(match[1]) >= seq) seq = Number(match[1]) + 1;
  }

  const values = items.map((p) => {
    const attrs: PlayerAttributes10 = {
      batting: clampAttr(p.battingRating),
      battingTiming: clampAttr(p.battingTiming ?? p.battingRating),
      powerHitting: clampAttr(p.powerHitting ?? p.battingRating - 4),
      bowling: clampAttr(p.bowlingRating),
      bowlingAccuracy: clampAttr(p.bowlingAccuracy ?? p.bowlingRating),
      swing: clampAttr(p.swing ?? (p.role === 'FAST_BOWLER' ? p.bowlingRating - 3 : 30)),
      spin: clampAttr(p.spin ?? (p.role === 'SPIN_BOWLER' ? p.bowlingRating - 3 : 30)),
      fielding: clampAttr(p.fieldingRating),
      stamina: clampAttr(p.stamina ?? 74),
      experience: clampAttr(p.experienceRating),
    };
    const expLevel = p.experienceLevel ?? deriveExperienceLevel(attrs.experience, p.age);
    const overallRating = calculateOverallRating(p.role, attrs);
    const valuation = calculatePlayerValuation({
      role: p.role,
      attributes: attrs,
      experienceLevel: expLevel,
      isOverseas: p.isOverseas,
      demandScore: 100,
    });
    const code = p.playerCode?.trim().toUpperCase() || `CVP-${String(seq++).padStart(4, '0')}`;

    return {
      playerCode: code,
      name: p.name.trim(),
      imageUrl: p.imageUrl?.trim() || PORTRAIT_BY_ROLE[p.role] || PORTRAIT_BY_ROLE.BATSMAN,
      age: p.age,
      nationality: p.nationality.trim(),
      isOverseas: p.isOverseas,
      nationalityCategory: (p.isOverseas ? 'OVERSEAS' : 'DOMESTIC') as NationalityCategory,
      role: p.role,
      battingStyle: p.battingStyle.trim(),
      bowlingStyle: p.bowlingStyle.trim(),
      battingRating: attrs.batting,
      battingTiming: attrs.battingTiming,
      powerHitting: attrs.powerHitting,
      bowlingRating: attrs.bowling,
      bowlingAccuracy: attrs.bowlingAccuracy,
      swing: attrs.swing,
      spin: attrs.spin,
      fieldingRating: attrs.fielding,
      stamina: attrs.stamina,
      consistencyRating: clampAttr(p.consistencyRating ?? Math.round((attrs.battingTiming + attrs.bowlingAccuracy) / 2)),
      experienceRating: attrs.experience,
      overallRating,
      experienceLevel: expLevel,
      availabilityStatus: (p.availabilityStatus ?? 'AVAILABLE') as AvailabilityStatus,
      isActive: (p.availabilityStatus ?? 'AVAILABLE') !== 'INACTIVE',
      demandScore: 100,
      valuationBreakdown: valuation,
      basePrice: typeof p.basePrice === 'number' ? Math.round(p.basePrice) : valuation.suggestedBasePrice,
      category: p.category ?? deriveCategoryFromLevel(expLevel, overallRating),
    };
  });

  const inserted = await db
    .insert(players)
    .values(values)
    .onConflictDoNothing({ target: players.playerCode })
    .returning();

  if (inserted.length > 0) {
    await db.insert(playerSeasons).values(
      inserted.map((p) => ({
        playerId: p.id,
        seasonName: 'Premier Series 2026',
        matchesPlayed: 14,
        runs: isBowlerRole(p.role) ? 45 : p.battingRating * 4,
        strikeRate: 130,
        wickets: isBatsmanRole(p.role) || isWicketkeeperRole(p.role) ? 0 : 12,
        economyRate: 745,
        ratingOverall: p.overallRating,
      }))
    );

    await db.insert(auditLogs).values({
      actorUserId,
      action: 'ADMIN_PLAYERS_IMPORTED',
      resourceType: 'PLAYER',
      details: { importedCount: inserted.length },
    });
  }

  return inserted;
}
