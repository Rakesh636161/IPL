export type PlayingRole =
  | 'BATSMAN'
  | 'OPENING_BATSMAN'
  | 'MIDDLE_ORDER_BATSMAN'
  | 'ALL_ROUNDER'
  | 'FAST_BOWLER'
  | 'SPIN_BOWLER'
  | 'BOWLER'
  | 'WICKETKEEPER';

export type ExperienceLevel = 'EMERGING' | 'PROFESSIONAL' | 'EXPERIENCED' | 'ELITE';
export type NationalityCategory = 'DOMESTIC' | 'OVERSEAS';
export type AvailabilityStatus = 'AVAILABLE' | 'INJURED' | 'INACTIVE';
export type OwnershipStatus = 'OWNED' | 'RELEASED' | 'LOANED';

export interface PlayerAttributes10 {
  batting: number;
  battingTiming: number;
  powerHitting: number;
  bowling: number;
  bowlingAccuracy: number;
  swing: number;
  spin: number;
  fielding: number;
  stamina: number;
  experience: number;
}

export interface ValuationConfig {
  minBasePrice: number; // integer Lakhs
  maxBasePrice: number; // integer Lakhs
  step: number; // integer Lakhs
  currencyLabel: string;
}

export const DEFAULT_VALUATION_CONFIG: ValuationConfig = {
  minBasePrice: 20,
  maxBasePrice: 250,
  step: 5,
  currencyLabel: 'Lakhs',
};

export interface ValuationBreakdown {
  overallRating: number;
  roleRarityMultiplier: number;
  experienceMultiplier: number;
  demandMultiplier: number;
  dualCapabilityBonus: number;
  overseasFactor: number;
  suggestedBasePrice: number;
  currency: string;
}

export interface SquadRulesConfig {
  minSquadSize: number;
  maxSquadSize: number;
  maxOverseas: number;
  minWicketkeepers: number;
  minBatsmen: number;
  minBowlers: number;
  minAllRounders: number;
}

export const DEFAULT_SQUAD_RULES: SquadRulesConfig = {
  minSquadSize: 15,
  maxSquadSize: 25,
  maxOverseas: 8,
  minWicketkeepers: 1,
  minBatsmen: 4,
  minBowlers: 4,
  minAllRounders: 2,
};

export interface SquadRuleCheck {
  key: string;
  label: string;
  required: string;
  actual: number;
  passed: boolean;
  message: string;
}

export interface SquadCompositionCounts {
  total: number;
  batsmen: number;
  bowlers: number;
  allRounders: number;
  wicketkeepers: number;
  overseas: number;
  domestic: number;
}

export interface SquadValidationResult {
  isValid: boolean;
  canMarkComplete: boolean;
  counts: SquadCompositionCounts;
  checks: SquadRuleCheck[];
}

export interface PlayingXiValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  xiCount: number;
  substituteCount: number;
  bowlingOptionsCount: number;
}

export const PLAYING_ROLE_LABELS: Record<PlayingRole, string> = {
  BATSMAN: 'Batsman',
  OPENING_BATSMAN: 'Opening Batsman',
  MIDDLE_ORDER_BATSMAN: 'Middle-Order Batsman',
  ALL_ROUNDER: 'All-Rounder',
  FAST_BOWLER: 'Fast Bowler',
  SPIN_BOWLER: 'Spin Bowler',
  BOWLER: 'Bowler',
  WICKETKEEPER: 'Wicketkeeper',
};

export const EXPERIENCE_LEVEL_LABELS: Record<ExperienceLevel, string> = {
  EMERGING: 'Emerging',
  PROFESSIONAL: 'Professional',
  EXPERIENCED: 'Experienced',
  ELITE: 'Elite',
};

export function clampAttr(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(100, Math.round(val)));
}

export function isBatsmanRole(role: string): boolean {
  return (
    role === 'BATSMAN' ||
    role === 'OPENING_BATSMAN' ||
    role === 'MIDDLE_ORDER_BATSMAN'
  );
}

export function isBowlerRole(role: string): boolean {
  return role === 'BOWLER' || role === 'FAST_BOWLER' || role === 'SPIN_BOWLER';
}

export function isAllRounderRole(role: string): boolean {
  return role === 'ALL_ROUNDER';
}

export function isWicketkeeperRole(role: string): boolean {
  return role === 'WICKETKEEPER';
}

/**
 * Role-weighted overall rating formula across the 10 cricket attributes (0–100).
 */
export function calculateOverallRating(role: PlayingRole | string, attrs: PlayerAttributes10): number {
  const b = clampAttr(attrs.batting);
  const bt = clampAttr(attrs.battingTiming);
  const ph = clampAttr(attrs.powerHitting);
  const bw = clampAttr(attrs.bowling);
  const ba = clampAttr(attrs.bowlingAccuracy);
  const sw = clampAttr(attrs.swing);
  const sp = clampAttr(attrs.spin);
  const fl = clampAttr(attrs.fielding);
  const st = clampAttr(attrs.stamina);
  const ex = clampAttr(attrs.experience);

  let weighted = 0;

  if (role === 'OPENING_BATSMAN') {
    weighted = b * 0.34 + bt * 0.28 + ph * 0.16 + fl * 0.08 + st * 0.07 + ex * 0.07;
  } else if (role === 'MIDDLE_ORDER_BATSMAN') {
    weighted = b * 0.32 + bt * 0.22 + ph * 0.24 + fl * 0.08 + st * 0.07 + ex * 0.07;
  } else if (role === 'BATSMAN') {
    weighted = b * 0.34 + bt * 0.24 + ph * 0.18 + fl * 0.09 + st * 0.07 + ex * 0.08;
  } else if (role === 'FAST_BOWLER') {
    weighted = bw * 0.36 + ba * 0.25 + sw * 0.19 + st * 0.08 + fl * 0.05 + ex * 0.07;
  } else if (role === 'SPIN_BOWLER') {
    weighted = bw * 0.36 + ba * 0.25 + sp * 0.19 + st * 0.08 + fl * 0.05 + ex * 0.07;
  } else if (role === 'BOWLER') {
    const primaryTech = Math.max(sw, sp);
    weighted = bw * 0.36 + ba * 0.25 + primaryTech * 0.18 + st * 0.08 + fl * 0.06 + ex * 0.07;
  } else if (role === 'ALL_ROUNDER') {
    const tech = Math.max(sw, sp);
    weighted =
      b * 0.2 +
      bt * 0.1 +
      ph * 0.1 +
      bw * 0.22 +
      ba * 0.14 +
      tech * 0.07 +
      fl * 0.06 +
      st * 0.06 +
      ex * 0.05;
  } else if (role === 'WICKETKEEPER') {
    weighted = b * 0.28 + bt * 0.18 + ph * 0.14 + fl * 0.24 + st * 0.08 + ex * 0.08;
  } else {
    weighted = (b + bt + ph + bw + ba + fl + st + ex) / 8;
  }

  return clampAttr(weighted);
}

const ROLE_RARITY_MULTIPLIER: Record<string, number> = {
  ALL_ROUNDER: 1.16,
  WICKETKEEPER: 1.1,
  FAST_BOWLER: 1.09,
  SPIN_BOWLER: 1.06,
  OPENING_BATSMAN: 1.05,
  MIDDLE_ORDER_BATSMAN: 1.04,
  BOWLER: 1.03,
  BATSMAN: 1.0,
};

const EXPERIENCE_MULTIPLIER: Record<ExperienceLevel, number> = {
  EMERGING: 0.82,
  PROFESSIONAL: 0.98,
  EXPERIENCED: 1.12,
  ELITE: 1.28,
};

export function deriveExperienceLevel(experienceRating: number, age: number): ExperienceLevel {
  if (experienceRating >= 86) return 'ELITE';
  if (experienceRating >= 74) return 'EXPERIENCED';
  if (experienceRating >= 60 || age >= 23) return 'PROFESSIONAL';
  return 'EMERGING';
}

export function deriveCategoryFromLevel(level: ExperienceLevel, overallRating: number): 'MARQUEE' | 'CAPS' | 'DOMESTIC' | 'EMERGING' {
  if (level === 'ELITE' || overallRating >= 85) return 'MARQUEE';
  if (level === 'EXPERIENCED' || overallRating >= 76) return 'CAPS';
  if (level === 'EMERGING') return 'EMERGING';
  return 'DOMESTIC';
}

/**
 * Computes a realistic integer base auction price (in Lakhs) based on:
 * - overall rating
 * - playing role & rarity
 * - batting + bowling capabilities
 * - experience level
 * - player demand factor
 */
export function calculatePlayerValuation(input: {
  role: PlayingRole | string;
  attributes: PlayerAttributes10;
  experienceLevel: ExperienceLevel;
  isOverseas: boolean;
  demandScore?: number; // 100 = 1.00x normal demand, 125 = 1.25x high demand
  config?: Partial<ValuationConfig>;
}): ValuationBreakdown {
  const cfg: ValuationConfig = { ...DEFAULT_VALUATION_CONFIG, ...input.config };
  const overallRating = calculateOverallRating(input.role, input.attributes);
  const roleRarityMultiplier = ROLE_RARITY_MULTIPLIER[input.role] ?? 1.0;
  const experienceMultiplier = EXPERIENCE_MULTIPLIER[input.experienceLevel] ?? 1.0;
  const demandMultiplier = Math.max(0.75, Math.min(1.4, (input.demandScore ?? 100) / 100));

  // Dual capability bonus for players who contribute meaningfully with both bat & ball
  const dualMin = Math.min(clampAttr(input.attributes.batting), clampAttr(input.attributes.bowling));
  const dualCapabilityBonus = dualMin >= 60 ? 1 + ((dualMin - 55) / 100) * 0.25 : 1.0;
  const overseasFactor = input.isOverseas ? 1.05 : 1.0;

  // Non-linear rating curve from rating 45..98 mapped onto minBasePrice..maxBasePrice
  const normalized = Math.max(0, Math.min(1, (overallRating - 48) / 47));
  const ratingCurve = Math.pow(normalized, 2.05);
  const rawBase = cfg.minBasePrice + ratingCurve * (cfg.maxBasePrice - cfg.minBasePrice) * 0.68;

  const valued =
    rawBase *
    roleRarityMultiplier *
    experienceMultiplier *
    demandMultiplier *
    dualCapabilityBonus *
    overseasFactor;

  const stepped = Math.round(valued / cfg.step) * cfg.step;
  const suggestedBasePrice = Math.max(cfg.minBasePrice, Math.min(cfg.maxBasePrice, Math.round(stepped)));

  return {
    overallRating,
    roleRarityMultiplier: Number(roleRarityMultiplier.toFixed(2)),
    experienceMultiplier: Number(experienceMultiplier.toFixed(2)),
    demandMultiplier: Number(demandMultiplier.toFixed(2)),
    dualCapabilityBonus: Number(dualCapabilityBonus.toFixed(2)),
    overseasFactor,
    suggestedBasePrice,
    currency: cfg.currencyLabel,
  };
}

export interface SquadPlayerShape {
  role: string;
  isOverseas: boolean;
  ownershipStatus?: string | null;
}

/**
 * Evaluates a team's squad against league squad rules without forcing completion mid-auction.
 */
export function validateSquadComposition(
  roster: SquadPlayerShape[],
  rulesInput?: Partial<SquadRulesConfig>
): SquadValidationResult {
  const rules: SquadRulesConfig = { ...DEFAULT_SQUAD_RULES, ...rulesInput };
  const activeRoster = roster.filter((r) => !r.ownershipStatus || r.ownershipStatus === 'OWNED');

  const counts: SquadCompositionCounts = {
    total: activeRoster.length,
    batsmen: activeRoster.filter((r) => isBatsmanRole(r.role)).length,
    bowlers: activeRoster.filter((r) => isBowlerRole(r.role)).length,
    allRounders: activeRoster.filter((r) => isAllRounderRole(r.role)).length,
    wicketkeepers: activeRoster.filter((r) => isWicketkeeperRole(r.role)).length,
    overseas: activeRoster.filter((r) => r.isOverseas).length,
    domestic: activeRoster.filter((r) => !r.isOverseas).length,
  };

  const checks: SquadRuleCheck[] = [
    {
      key: 'minSquadSize',
      label: 'Minimum Squad Size',
      required: `>= ${rules.minSquadSize}`,
      actual: counts.total,
      passed: counts.total >= rules.minSquadSize,
      message:
        counts.total >= rules.minSquadSize
          ? `Squad meets minimum size (${counts.total}/${rules.minSquadSize}).`
          : `Need ${rules.minSquadSize - counts.total} more player(s) to reach minimum squad of ${rules.minSquadSize}.`,
    },
    {
      key: 'maxSquadSize',
      label: 'Maximum Squad Size',
      required: `<= ${rules.maxSquadSize}`,
      actual: counts.total,
      passed: counts.total <= rules.maxSquadSize,
      message:
        counts.total <= rules.maxSquadSize
          ? `Within max squad cap (${counts.total}/${rules.maxSquadSize}).`
          : `Squad exceeds maximum allowed size (${counts.total}/${rules.maxSquadSize}).`,
    },
    {
      key: 'maxOverseas',
      label: 'Overseas Players Cap',
      required: `<= ${rules.maxOverseas}`,
      actual: counts.overseas,
      passed: counts.overseas <= rules.maxOverseas,
      message:
        counts.overseas <= rules.maxOverseas
          ? `Overseas quota valid (${counts.overseas}/${rules.maxOverseas}).`
          : `Exceeded max overseas players (${counts.overseas}/${rules.maxOverseas}).`,
    },
    {
      key: 'minWicketkeepers',
      label: 'Specialist Wicketkeepers',
      required: `>= ${rules.minWicketkeepers}`,
      actual: counts.wicketkeepers,
      passed: counts.wicketkeepers >= rules.minWicketkeepers,
      message:
        counts.wicketkeepers >= rules.minWicketkeepers
          ? `Wicketkeeper requirement met (${counts.wicketkeepers}/${rules.minWicketkeepers}).`
          : `Need ${rules.minWicketkeepers - counts.wicketkeepers} more wicketkeeper(s).`,
    },
    {
      key: 'minBatsmen',
      label: 'Specialist Batsmen',
      required: `>= ${rules.minBatsmen}`,
      actual: counts.batsmen,
      passed: counts.batsmen >= rules.minBatsmen,
      message:
        counts.batsmen >= rules.minBatsmen
          ? `Specialist batsmen requirement met (${counts.batsmen}/${rules.minBatsmen}).`
          : `Need ${rules.minBatsmen - counts.batsmen} more specialist batsman(s).`,
    },
    {
      key: 'minBowlers',
      label: 'Specialist Bowlers',
      required: `>= ${rules.minBowlers}`,
      actual: counts.bowlers,
      passed: counts.bowlers >= rules.minBowlers,
      message:
        counts.bowlers >= rules.minBowlers
          ? `Specialist bowlers requirement met (${counts.bowlers}/${rules.minBowlers}).`
          : `Need ${rules.minBowlers - counts.bowlers} more specialist bowler(s).`,
    },
    {
      key: 'minAllRounders',
      label: 'All-Rounders',
      required: `>= ${rules.minAllRounders}`,
      actual: counts.allRounders,
      passed: counts.allRounders >= rules.minAllRounders,
      message:
        counts.allRounders >= rules.minAllRounders
          ? `All-rounders requirement met (${counts.allRounders}/${rules.minAllRounders}).`
          : `Need ${rules.minAllRounders - counts.allRounders} more all-rounder(s).`,
    },
  ];

  const isValid = checks.every((c) => c.passed);

  return {
    isValid,
    canMarkComplete: isValid,
    counts,
    checks,
  };
}

export interface PlayingXiValidationInput {
  ownedPlayerIds: string[];
  playingXiIds: string[];
  substituteIds?: string[];
  captainPlayerId?: string | null;
  viceCaptainPlayerId?: string | null;
  wicketkeeperPlayerId?: string | null;
  bowlingOrderIds?: string[];
  maxOverseasInXi?: number;
  overseasPlayerIds?: Set<string>;
}

/**
 * Validates Playing XI match readiness:
 * - No duplicate player selections
 * - Every selected player must be owned by this team
 * - Exactly 11 unique players in Playing XI
 * - Valid Captain, Vice-Captain (distinct from Captain), and Wicketkeeper inside Playing XI
 * - At least 1 bowling option designated (recommended 5)
 */
export function validatePlayingXiSelection(input: PlayingXiValidationInput): PlayingXiValidationResult {
  const ownedSet = new Set(input.ownedPlayerIds);
  const errors: string[] = [];
  const warnings: string[] = [];

  const uniqueXi = Array.from(new Set(input.playingXiIds));
  if (uniqueXi.length !== input.playingXiIds.length) {
    errors.push('Duplicate players detected in Playing XI.');
  }

  for (const pid of input.playingXiIds) {
    if (!ownedSet.has(pid)) {
      errors.push(`Player ${pid} is not owned by this franchise.`);
    }
  }

  if (input.substituteIds) {
    const uniqueSubs = Array.from(new Set(input.substituteIds));
    if (uniqueSubs.length !== input.substituteIds.length) {
      errors.push('Duplicate players detected in Substitutes.');
    }
    const xiSet = new Set(uniqueXi);
    for (const sid of input.substituteIds) {
      if (!ownedSet.has(sid)) {
        errors.push(`Substitute player ${sid} is not owned by this franchise.`);
      }
      if (xiSet.has(sid)) {
        errors.push(`Player ${sid} cannot be both in Playing XI and Substitutes.`);
      }
    }
  }

  if (uniqueXi.length !== 11) {
    errors.push(`Playing XI must contain exactly 11 players (currently ${uniqueXi.length}/11).`);
  }

  const xiSet = new Set(uniqueXi);
  if (!input.captainPlayerId) {
    errors.push('Captain must be assigned.');
  } else if (!xiSet.has(input.captainPlayerId)) {
    errors.push('Captain must be included in the Playing XI.');
  }

  if (!input.viceCaptainPlayerId) {
    errors.push('Vice-Captain must be assigned.');
  } else {
    if (!xiSet.has(input.viceCaptainPlayerId)) {
      errors.push('Vice-Captain must be included in the Playing XI.');
    }
    if (input.captainPlayerId && input.viceCaptainPlayerId === input.captainPlayerId) {
      errors.push('Captain and Vice-Captain cannot be the same player.');
    }
  }

  if (!input.wicketkeeperPlayerId) {
    errors.push('Wicketkeeper must be assigned.');
  } else if (!xiSet.has(input.wicketkeeperPlayerId)) {
    errors.push('Wicketkeeper must be included in the Playing XI.');
  }

  const bowlIds = input.bowlingOrderIds ?? [];
  const uniqueBowlers = Array.from(new Set(bowlIds));
  if (uniqueBowlers.length !== bowlIds.length) {
    errors.push('Duplicate players detected in bowling options.');
  }
  for (const bid of bowlIds) {
    if (!xiSet.has(bid)) {
      errors.push('All bowling options must be inside the Playing XI.');
      break;
    }
  }

  if (uniqueBowlers.length === 0) {
    warnings.push('Select at least 5 bowling options from your Playing XI for balanced overs.');
  } else if (uniqueBowlers.length < 5) {
    warnings.push(`Only ${uniqueBowlers.length} bowling option(s) selected; 5+ is recommended for a 20-over match.`);
  }

  if (input.maxOverseasInXi && input.overseasPlayerIds) {
    const overseasInXi = uniqueXi.filter((id) => input.overseasPlayerIds!.has(id)).length;
    if (overseasInXi > input.maxOverseasInXi) {
      errors.push(`Playing XI exceeds max overseas limit (${overseasInXi}/${input.maxOverseasInXi}).`);
    }
  }

  const substituteCount = Math.max(0, ownedSet.size - uniqueXi.length);

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    xiCount: uniqueXi.length,
    substituteCount,
    bowlingOptionsCount: uniqueBowlers.length,
  };
}
