import { count } from 'drizzle-orm';
import { db } from './index.ts';
import { players, playerSeasons } from './schema.ts';
import {
  AvailabilityStatus,
  calculateOverallRating,
  calculatePlayerValuation,
  clampAttr,
  deriveCategoryFromLevel,
  ExperienceLevel,
  NationalityCategory,
  PlayingRole,
  ValuationBreakdown,
} from '../lib/cricketEngine.ts';

export interface SeedPlayerInput {
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
  valuationBreakdown: ValuationBreakdown;
  basePrice: number; // Integer Lakhs
  category: 'MARQUEE' | 'CAPS' | 'DOMESTIC' | 'EMERGING';
}

const PORTRAIT_BY_ROLE: Record<PlayingRole, string> = {
  BATSMAN: '/src/assets/images/player_batsman_portrait_1794578454251.jpg',
  OPENING_BATSMAN: '/src/assets/images/player_batsman_portrait_1794578454251.jpg',
  MIDDLE_ORDER_BATSMAN: '/src/assets/images/player_batsman_portrait_1794578454251.jpg',
  ALL_ROUNDER: '/src/assets/images/player_batsman_portrait_1794578454251.jpg',
  BOWLER: '/src/assets/images/player_bowler_portrait_1794578454903.jpg',
  FAST_BOWLER: '/src/assets/images/player_bowler_portrait_1794578454903.jpg',
  SPIN_BOWLER: '/src/assets/images/player_bowler_portrait_1794578454903.jpg',
  WICKETKEEPER: '/src/assets/images/player_keeper_portrait_1794578452592.jpg',
};

// Strictly original fictional player names
const FIRST_NAMES_DOMESTIC = [
  'Aarav', 'Vivaan', 'Devansh', 'Pranav', 'Siddharth', 'Karthik', 'Nikhil', 'Tanmay',
  'Harsh', 'Kunal', 'Manav', 'Reyansh', 'Tejas', 'Raghav', 'Gautam', 'Tarun',
  'Anirudh', 'Mihir', 'Advait', 'Parth', 'Naman', 'Samarth', 'Vihaan', 'Rishabh',
  'Chirag', 'Yuvraj', 'Darshan', 'Kabir', 'Omkar', 'Pratik', 'Soham', 'Vedant',
];

const LAST_NAMES_DOMESTIC = [
  'Deshmukh', 'Kulkarni', 'Nair', 'Menon', 'Chatterjee', 'Banerjee', 'Joshi',
  'Saxena', 'Malhotra', 'Kapoor', 'Bhatia', 'Tiwari', 'Srivastava', 'Gowda',
  'Choudhary', 'Rathore', 'Solanki', 'Mehta', 'Kamble', 'Sawant', 'Bhandari',
  'Shetty', 'Khatri', 'Subramanian',
];

const OVERSEAS_FIRST = [
  'Lachlan', 'Callum', 'Hamish', 'Declan', 'Oliver', 'Harrison', 'Sebastian', 'Tristan',
  'Hendrik', 'Pieter', 'Francois', 'Willem', 'Gideon', 'Bram', 'Kieran', 'Caleb',
  'Alistair', 'Malik', 'Tariq', 'Zaydan', 'Kofi', 'Dante', 'Henrik', 'Soren',
];

const OVERSEAS_LAST = [
  { last: 'McAllister', country: 'Australia' },
  { last: 'Thornton', country: 'Australia' },
  { last: 'Hargreaves', country: 'Australia' },
  { last: 'Pendleton', country: 'England' },
  { last: 'Whitaker', country: 'England' },
  { last: 'Pryce', country: 'England' },
  { last: 'Van Der Berg', country: 'South Africa' },
  { last: 'Louwrens', country: 'South Africa' },
  { last: 'Mokoena', country: 'South Africa' },
  { last: 'McIntyre', country: 'New Zealand' },
  { last: 'Gallagher', country: 'New Zealand' },
  { last: 'Caldwell', country: 'New Zealand' },
  { last: 'Baptiste', country: 'West Indies' },
  { last: 'Brathmore', country: 'West Indies' },
  { last: 'Stanikzai', country: 'Afghanistan' },
  { last: 'Farooqi', country: 'Afghanistan' },
  { last: 'Wickramage', country: 'Sri Lanka' },
  { last: 'Bandaranaike', country: 'Sri Lanka' },
  { last: 'Chowdhury', country: 'Bangladesh' },
  { last: 'Hossainov', country: 'Bangladesh' },
];

const ROLES: PlayingRole[] = [
  'OPENING_BATSMAN',
  'MIDDLE_ORDER_BATSMAN',
  'BATSMAN',
  'ALL_ROUNDER',
  'FAST_BOWLER',
  'SPIN_BOWLER',
  'WICKETKEEPER',
  'BOWLER',
];

const BATTING_STYLES = [
  'Right-hand Aggressive',
  'Left-hand Anchor',
  'Right-hand Stroke-maker',
  'Left-hand Finisher',
];
const PACE_STYLES = [
  'Right-arm Express',
  'Left-arm Swing',
  'Right-arm Seam',
  'Left-arm Yorker Specialist',
];
const SPIN_STYLES = [
  'Right-arm Legbreak',
  'Left-arm Orthodox',
  'Right-arm Offbreak',
  'Left-arm Wrist-spin',
];

export function generateFictionalPlayers(totalCount = 128): SeedPlayerInput[] {
  const list: SeedPlayerInput[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < totalCount; i++) {
    const role = ROLES[i % ROLES.length];
    const isOverseas = i % 3 === 0;
    const nationalityCategory: NationalityCategory = isOverseas ? 'OVERSEAS' : 'DOMESTIC';

    let name = '';
    let nationality = 'India';

    if (isOverseas) {
      const fn = OVERSEAS_FIRST[(i * 5 + 3) % OVERSEAS_FIRST.length];
      const ov = OVERSEAS_LAST[(i * 7 + 1) % OVERSEAS_LAST.length];
      nationality = ov.country;
      name = `${fn} ${ov.last}`;
      if (usedNames.has(name)) {
        const altFn = OVERSEAS_FIRST[(i * 11 + 5) % OVERSEAS_FIRST.length];
        name = `${altFn} ${ov.last}`;
      }
    } else {
      const fn = FIRST_NAMES_DOMESTIC[(i * 7 + 2) % FIRST_NAMES_DOMESTIC.length];
      const ln = LAST_NAMES_DOMESTIC[(i * 11 + 5) % LAST_NAMES_DOMESTIC.length];
      name = `${fn} ${ln}`;
      if (usedNames.has(name)) {
        const altFn = FIRST_NAMES_DOMESTIC[(i * 13 + 9) % FIRST_NAMES_DOMESTIC.length];
        name = `${altFn} ${ln}`;
      }
    }
    if (usedNames.has(name)) {
      name = `${name} ${['II', 'Jr', 'K'][i % 3]}`;
    }
    usedNames.add(name);

    // Balanced distribution across 4 experience tiers
    let experienceLevel: ExperienceLevel = 'PROFESSIONAL';
    let tierBoost = 6;
    if (i < Math.round(totalCount * 0.15)) {
      experienceLevel = 'ELITE';
      tierBoost = 18;
    } else if (i < Math.round(totalCount * 0.45)) {
      experienceLevel = 'EXPERIENCED';
      tierBoost = 12;
    } else if (i < Math.round(totalCount * 0.78)) {
      experienceLevel = 'PROFESSIONAL';
      tierBoost = 5;
    } else {
      experienceLevel = 'EMERGING';
      tierBoost = 0;
    }

    const jitter = (seed: number, range: number) => ((i * seed + 17) % range);

    let battingRating = 48 + tierBoost + jitter(5, 16);
    let battingTiming = 48 + tierBoost + jitter(7, 16);
    let powerHitting = 46 + tierBoost + jitter(11, 18);
    let bowlingRating = 36 + tierBoost + jitter(7, 16);
    let bowlingAccuracy = 40 + tierBoost + jitter(9, 15);
    let swing = 25 + jitter(5, 25);
    let spin = 25 + jitter(7, 25);
    let fieldingRating = 62 + Math.floor(tierBoost / 2) + jitter(3, 18);
    const stamina = clampAttr(66 + Math.floor(tierBoost / 2) + jitter(13, 19));

    if (role === 'OPENING_BATSMAN') {
      battingRating = clampAttr(72 + tierBoost + jitter(3, 10));
      battingTiming = clampAttr(73 + tierBoost + jitter(5, 11));
      powerHitting = clampAttr(66 + tierBoost + jitter(9, 14));
      bowlingRating = clampAttr(22 + jitter(5, 22));
      bowlingAccuracy = clampAttr(25 + jitter(3, 20));
    } else if (role === 'MIDDLE_ORDER_BATSMAN') {
      battingRating = clampAttr(71 + tierBoost + jitter(7, 10));
      battingTiming = clampAttr(68 + tierBoost + jitter(5, 12));
      powerHitting = clampAttr(74 + tierBoost + jitter(3, 11));
      bowlingRating = clampAttr(28 + jitter(7, 24));
      bowlingAccuracy = clampAttr(30 + jitter(5, 22));
    } else if (role === 'BATSMAN') {
      battingRating = clampAttr(72 + tierBoost + jitter(3, 11));
      battingTiming = clampAttr(70 + tierBoost + jitter(7, 11));
      powerHitting = clampAttr(68 + tierBoost + jitter(11, 13));
      bowlingRating = clampAttr(26 + jitter(5, 24));
      bowlingAccuracy = clampAttr(28 + jitter(3, 22));
    } else if (role === 'WICKETKEEPER') {
      battingRating = clampAttr(69 + tierBoost + jitter(7, 11));
      battingTiming = clampAttr(67 + tierBoost + jitter(5, 12));
      powerHitting = clampAttr(68 + tierBoost + jitter(9, 13));
      bowlingRating = clampAttr(15 + jitter(2, 14));
      bowlingAccuracy = clampAttr(15 + jitter(3, 12));
      swing = 12;
      spin = 12;
      fieldingRating = clampAttr(78 + Math.floor(tierBoost / 2) + jitter(3, 10));
    } else if (role === 'ALL_ROUNDER') {
      battingRating = clampAttr(66 + tierBoost + jitter(5, 12));
      battingTiming = clampAttr(64 + tierBoost + jitter(7, 12));
      powerHitting = clampAttr(68 + tierBoost + jitter(9, 13));
      bowlingRating = clampAttr(66 + tierBoost + jitter(9, 12));
      bowlingAccuracy = clampAttr(65 + tierBoost + jitter(5, 12));
      if (i % 2 === 0) {
        swing = clampAttr(65 + tierBoost + jitter(3, 13));
        spin = clampAttr(30 + jitter(5, 20));
      } else {
        spin = clampAttr(65 + tierBoost + jitter(5, 13));
        swing = clampAttr(30 + jitter(3, 20));
      }
    } else if (role === 'FAST_BOWLER') {
      battingRating = clampAttr(28 + jitter(11, 26));
      battingTiming = clampAttr(26 + jitter(7, 22));
      powerHitting = clampAttr(34 + jitter(9, 25));
      bowlingRating = clampAttr(73 + tierBoost + jitter(5, 10));
      bowlingAccuracy = clampAttr(70 + tierBoost + jitter(7, 12));
      swing = clampAttr(71 + tierBoost + jitter(3, 12));
      spin = clampAttr(18 + jitter(3, 15));
    } else if (role === 'SPIN_BOWLER') {
      battingRating = clampAttr(32 + jitter(11, 25));
      battingTiming = clampAttr(30 + jitter(7, 24));
      powerHitting = clampAttr(30 + jitter(9, 22));
      bowlingRating = clampAttr(73 + tierBoost + jitter(7, 10));
      bowlingAccuracy = clampAttr(72 + tierBoost + jitter(5, 12));
      spin = clampAttr(73 + tierBoost + jitter(3, 11));
      swing = clampAttr(20 + jitter(3, 14));
    } else if (role === 'BOWLER') {
      battingRating = clampAttr(30 + jitter(9, 24));
      battingTiming = clampAttr(28 + jitter(5, 22));
      powerHitting = clampAttr(32 + jitter(7, 24));
      bowlingRating = clampAttr(72 + tierBoost + jitter(5, 11));
      bowlingAccuracy = clampAttr(70 + tierBoost + jitter(9, 11));
      if (i % 2 === 0) {
        swing = clampAttr(68 + tierBoost + jitter(3, 12));
        spin = clampAttr(22 + jitter(3, 14));
      } else {
        spin = clampAttr(68 + tierBoost + jitter(5, 12));
        swing = clampAttr(22 + jitter(3, 14));
      }
    }

    const experienceRating = clampAttr(
      experienceLevel === 'ELITE'
        ? 86 + jitter(7, 12)
        : experienceLevel === 'EXPERIENCED'
        ? 74 + jitter(5, 11)
        : experienceLevel === 'PROFESSIONAL'
        ? 60 + jitter(3, 13)
        : 40 + jitter(7, 18)
    );
    const consistencyRating = clampAttr(58 + tierBoost + jitter(13, 16));
    const age =
      experienceLevel === 'EMERGING'
        ? 18 + (i % 4)
        : experienceLevel === 'ELITE'
        ? 27 + (i % 8)
        : 22 + (i % 10);

    const attrs = {
      batting: battingRating,
      battingTiming,
      powerHitting,
      bowling: bowlingRating,
      bowlingAccuracy,
      swing,
      spin,
      fielding: fieldingRating,
      stamina,
      experience: experienceRating,
    };

    const overallRating = calculateOverallRating(role, attrs);
    const demandScore = 92 + ((i * 7) % 32); // 92..123 -> 0.92x..1.23x
    const valuation = calculatePlayerValuation({
      role,
      attributes: attrs,
      experienceLevel,
      isOverseas,
      demandScore,
    });
    const category = deriveCategoryFromLevel(experienceLevel, overallRating);

    const battingStyle = BATTING_STYLES[i % BATTING_STYLES.length];
    let bowlingStyle = 'Part-time Medium';
    if (role === 'FAST_BOWLER' || (role === 'BOWLER' && i % 2 === 0)) {
      bowlingStyle = PACE_STYLES[i % PACE_STYLES.length];
    } else if (role === 'SPIN_BOWLER' || (role === 'BOWLER' && i % 2 === 1)) {
      bowlingStyle = SPIN_STYLES[i % SPIN_STYLES.length];
    } else if (role === 'ALL_ROUNDER') {
      bowlingStyle = i % 2 === 0 ? PACE_STYLES[i % PACE_STYLES.length] : SPIN_STYLES[i % SPIN_STYLES.length];
    } else if (role === 'WICKETKEEPER') {
      bowlingStyle = 'Does not bowl';
    }

    list.push({
      playerCode: `CVP-${String(i + 1).padStart(4, '0')}`,
      name,
      imageUrl: PORTRAIT_BY_ROLE[role],
      age,
      nationality,
      isOverseas,
      nationalityCategory,
      role,
      battingStyle,
      bowlingStyle,
      battingRating,
      battingTiming,
      powerHitting,
      bowlingRating,
      bowlingAccuracy,
      swing,
      spin,
      fieldingRating,
      stamina,
      consistencyRating,
      experienceRating,
      overallRating,
      experienceLevel,
      availabilityStatus: 'AVAILABLE',
      isActive: true,
      demandScore,
      valuationBreakdown: valuation,
      basePrice: valuation.suggestedBasePrice,
      category,
    });
  }

  return list;
}

let seedPromise: Promise<void> | null = null;

export async function ensurePlayersSeeded(): Promise<void> {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    try {
      const [{ total }] = await db.select({ total: count() }).from(players);
      if (Number(total) >= 100) return;

      const generated = generateFictionalPlayers(128);
      const inserted = await db
        .insert(players)
        .values(generated)
        .onConflictDoNothing({ target: players.playerCode })
        .returning({
          id: players.id,
          role: players.role,
          battingRating: players.battingRating,
          bowlingRating: players.bowlingRating,
          overallRating: players.overallRating,
        });

      if (inserted.length > 0) {
        const seasons = inserted.map((p, idx) => ({
          playerId: p.id,
          seasonName: 'Premier Series 2026',
          matchesPlayed: 12 + (idx % 18),
          runs:
            p.role === 'BOWLER' || p.role === 'FAST_BOWLER' || p.role === 'SPIN_BOWLER'
              ? 40 + (idx % 65)
              : 240 + p.battingRating * 4,
          strikeRate: 116 + (p.battingRating % 42),
          wickets:
            p.role === 'BATSMAN' ||
            p.role === 'OPENING_BATSMAN' ||
            p.role === 'MIDDLE_ORDER_BATSMAN' ||
            p.role === 'WICKETKEEPER'
              ? 0
              : 10 + (p.bowlingRating % 18),
          economyRate: 640 + (100 - p.bowlingRating) * 5,
          ratingOverall: p.overallRating,
        }));
        await db.insert(playerSeasons).values(seasons);
      }
      console.log(`[Seed] Seeded ${inserted.length} fictional cricket players.`);
    } catch (error) {
      seedPromise = null;
      console.error('[Seed] Failed to seed players:', error);
    }
  })();
  return seedPromise;
}
