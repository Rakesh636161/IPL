import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpDown,
  CheckCircle2,
  Edit3,
  Eye,
  Plus,
  Power,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import {
  AvailabilityStatus,
  CricketPlayer,
  ExperienceLevel,
  PlayerAttributes10,
  PlayingRole,
  formatCurrency,
} from '../types/cricketverse.ts';
import {
  EXPERIENCE_LEVEL_LABELS,
  PLAYING_ROLE_LABELS,
  calculateOverallRating,
  calculatePlayerValuation,
  clampAttr,
} from '../lib/cricketEngine.ts';
import { syncAdminPlayerFirestore } from '../services/playerFirestoreService.ts';
import { PlayerImage } from './PlayerImage.tsx';

type DatabaseTab =
  | 'ALL'
  | 'BATSMEN'
  | 'BOWLERS'
  | 'ALL_ROUNDERS'
  | 'WICKETKEEPERS'
  | 'EMERGING'
  | 'OVERSEAS'
  | 'ELITE';

const DATABASE_TABS: Array<{ id: DatabaseTab; label: string }> = [
  { id: 'ALL', label: 'All Players' },
  { id: 'BATSMEN', label: 'Batsmen' },
  { id: 'BOWLERS', label: 'Bowlers' },
  { id: 'ALL_ROUNDERS', label: 'All-Rounders' },
  { id: 'WICKETKEEPERS', label: 'Wicketkeepers' },
  { id: 'EMERGING', label: 'Emerging Players' },
  { id: 'OVERSEAS', label: 'Overseas Players' },
  { id: 'ELITE', label: 'Elite Players' },
];

const PLAYING_ROLES: PlayingRole[] = [
  'BATSMAN',
  'OPENING_BATSMAN',
  'MIDDLE_ORDER_BATSMAN',
  'ALL_ROUNDER',
  'FAST_BOWLER',
  'SPIN_BOWLER',
  'BOWLER',
  'WICKETKEEPER',
];

const EXPERIENCE_LEVELS: ExperienceLevel[] = ['EMERGING', 'PROFESSIONAL', 'EXPERIENCED', 'ELITE'];
const AVAILABILITY_OPTIONS: AvailabilityStatus[] = ['AVAILABLE', 'INJURED', 'INACTIVE'];

const AVATAR_PRESETS = [
  { label: 'Batter Portrait', url: '/src/assets/images/player_batsman_portrait_1794578454251.jpg' },
  { label: 'Bowler Portrait', url: '/src/assets/images/player_bowler_portrait_1794578454903.jpg' },
  { label: 'Keeper Portrait', url: '/src/assets/images/player_keeper_portrait_1794578452592.jpg' },
];

const SAMPLE_IMPORT_JSON = JSON.stringify(
  [
    {
      name: 'Nikhil Deshmukh',
      age: 22,
      nationality: 'India',
      isOverseas: false,
      role: 'OPENING_BATSMAN',
      battingStyle: 'Right-Hand Bat',
      bowlingStyle: 'Right-Arm Offbreak',
      battingRating: 78,
      battingTiming: 80,
      powerHitting: 76,
      bowlingRating: 32,
      bowlingAccuracy: 35,
      swing: 22,
      spin: 34,
      fieldingRating: 79,
      stamina: 82,
      experienceRating: 61,
      experienceLevel: 'PROFESSIONAL',
      availabilityStatus: 'AVAILABLE',
    },
    {
      name: 'Callum Henderson',
      age: 26,
      nationality: 'Scotland',
      isOverseas: true,
      role: 'FAST_BOWLER',
      battingStyle: 'Left-Hand Bat',
      bowlingStyle: 'Left-Arm Fast',
      battingRating: 36,
      battingTiming: 34,
      powerHitting: 40,
      bowlingRating: 85,
      bowlingAccuracy: 83,
      swing: 86,
      spin: 18,
      fieldingRating: 73,
      stamina: 84,
      experienceRating: 77,
      experienceLevel: 'EXPERIENCED',
      availabilityStatus: 'AVAILABLE',
    },
  ],
  null,
  2
);

interface PlayerFormState {
  id: string | null;
  name: string;
  age: number;
  nationality: string;
  isOverseas: boolean;
  role: PlayingRole;
  battingStyle: string;
  bowlingStyle: string;
  experienceLevel: ExperienceLevel;
  availabilityStatus: AvailabilityStatus;
  isActive: boolean;
  demandScore: number;
  basePrice: number;
  imageUrl: string;
  attributes: PlayerAttributes10;
}

function defaultPlayerForm(): PlayerFormState {
  const attributes: PlayerAttributes10 = {
    batting: 72,
    battingTiming: 70,
    powerHitting: 68,
    bowling: 40,
    bowlingAccuracy: 42,
    swing: 32,
    spin: 28,
    fielding: 74,
    stamina: 76,
    experience: 64,
  };
  const valuation = calculatePlayerValuation({
    role: 'BATSMAN',
    attributes,
    experienceLevel: 'PROFESSIONAL',
    isOverseas: false,
    demandScore: 100,
  });

  return {
    id: null,
    name: '',
    age: 24,
    nationality: 'India',
    isOverseas: false,
    role: 'BATSMAN',
    battingStyle: 'Right-Hand Bat',
    bowlingStyle: 'Right-Arm Medium',
    experienceLevel: 'PROFESSIONAL',
    availabilityStatus: 'AVAILABLE',
    isActive: true,
    demandScore: 100,
    basePrice: valuation.suggestedBasePrice,
    imageUrl: AVATAR_PRESETS[0].url,
    attributes,
  };
}

function formFromPlayer(p: CricketPlayer): PlayerFormState {
  return {
    id: p.id,
    name: p.name,
    age: p.age,
    nationality: p.nationality,
    isOverseas: p.isOverseas,
    role: p.role,
    battingStyle: p.battingStyle,
    bowlingStyle: p.bowlingStyle,
    experienceLevel: p.experienceLevel,
    availabilityStatus: p.availabilityStatus,
    isActive: p.isActive,
    demandScore: p.demandScore ?? 100,
    basePrice: p.basePrice,
    imageUrl: p.imageUrl || AVATAR_PRESETS[0].url,
    attributes: {
      batting: p.battingRating,
      battingTiming: p.battingTiming,
      powerHitting: p.powerHitting,
      bowling: p.bowlingRating,
      bowlingAccuracy: p.bowlingAccuracy,
      swing: p.swing,
      spin: p.spin,
      fielding: p.fieldingRating,
      stamina: p.stamina,
      experience: p.experienceRating,
    },
  };
}

async function compressAvatarFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Unsupported image format.'));
      img.onload = () => {
        const maxDim = 256;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context unavailable.'));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        if (dataUrl.length > 360000) {
          reject(new Error('Compressed image exceeds maximum allowed size.'));
          return;
        }
        resolve(dataUrl);
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

const ATTRIBUTE_FIELDS: Array<{ key: keyof PlayerAttributes10; label: string }> = [
  { key: 'batting', label: 'Batting' },
  { key: 'battingTiming', label: 'Batting Timing' },
  { key: 'powerHitting', label: 'Power Hitting' },
  { key: 'bowling', label: 'Bowling' },
  { key: 'bowlingAccuracy', label: 'Bowling Accuracy' },
  { key: 'swing', label: 'Swing' },
  { key: 'spin', label: 'Spin' },
  { key: 'fielding', label: 'Fielding' },
  { key: 'stamina', label: 'Stamina' },
  { key: 'experience', label: 'Experience' },
];

export const PlayersDatabaseView: React.FC = () => {
  const { apiFetch, dbUser } = useAuth();
  const isAdmin = dbUser?.role === 'ADMIN' || dbUser?.role === 'OWNER';

  const [players, setPlayers] = useState<CricketPlayer[]>([]);
  const [tab, setTab] = useState<DatabaseTab>('ALL');
  const [role, setRole] = useState<string>('ALL');
  const [nationalityCategory, setNationalityCategory] = useState<string>('ALL');
  const [minRating, setMinRating] = useState<number>(0);
  const [availability, setAvailability] = useState<string>('ALL');
  const [includeInactive, setIncludeInactive] = useState<boolean>(false);
  const [sortBy, setSortBy] = useState<'overallRating' | 'basePrice' | 'name'>('overallRating');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  const [detailPlayer, setDetailPlayer] = useState<CricketPlayer | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formState, setFormState] = useState<PlayerFormState>(defaultPlayerForm);
  const [savingForm, setSavingForm] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState(SAMPLE_IMPORT_JSON);
  const [importing, setImporting] = useState(false);

  const loadPlayers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (tab !== 'ALL') params.set('tab', tab);
      if (role !== 'ALL') params.set('role', role);
      if (nationalityCategory !== 'ALL') params.set('nationalityCategory', nationalityCategory);
      if (minRating > 0) params.set('minRating', String(minRating));
      if (availability !== 'ALL') params.set('availability', availability);
      if (isAdmin && includeInactive) params.set('includeInactive', 'true');
      params.set('sortBy', sortBy);
      params.set('sortDir', sortDir);
      if (search.trim()) params.set('q', search.trim());

      const res = await apiFetch<{ players: CricketPlayer[] }>(`/api/players?${params.toString()}`);
      setPlayers(res.players || []);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to load cricket player pool.',
      });
    } finally {
      setLoading(false);
    }
  }, [
    apiFetch,
    tab,
    role,
    nationalityCategory,
    minRating,
    availability,
    isAdmin,
    includeInactive,
    sortBy,
    sortDir,
    search,
  ]);

  useEffect(() => {
    loadPlayers();
  }, [tab, role, nationalityCategory, minRating, availability, includeInactive, sortBy, sortDir]);

  const liveValuation = useMemo(
    () =>
      calculatePlayerValuation({
        role: formState.role,
        attributes: formState.attributes,
        experienceLevel: formState.experienceLevel,
        isOverseas: formState.isOverseas,
        demandScore: formState.demandScore,
      }),
    [
      formState.role,
      formState.attributes,
      formState.experienceLevel,
      formState.isOverseas,
      formState.demandScore,
    ]
  );

  const liveOverallRating = useMemo(
    () => calculateOverallRating(formState.role, formState.attributes),
    [formState.role, formState.attributes]
  );

  const openCreateModal = () => {
    setFormState(defaultPlayerForm());
    setFormOpen(true);
    setFeedback(null);
  };

  const openEditModal = (player: CricketPlayer) => {
    setFormState(formFromPlayer(player));
    setFormOpen(true);
    setFeedback(null);
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressAvatarFile(file);
      setFormState((prev) => ({ ...prev, imageUrl: dataUrl }));
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Avatar upload failed.',
      });
    }
  };

  const handleSavePlayer = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingForm(true);
    setFeedback(null);
    try {
      if (formState.id) {
        const res = await apiFetch<{ player: CricketPlayer }>(`/api/admin/players/${formState.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: formState.name.trim(),
            age: Number(formState.age),
            nationality: formState.nationality.trim(),
            isOverseas: formState.isOverseas,
            role: formState.role,
            battingStyle: formState.battingStyle.trim(),
            bowlingStyle: formState.bowlingStyle.trim(),
            experienceLevel: formState.experienceLevel,
            availabilityStatus: formState.availabilityStatus,
            isActive: formState.isActive,
            demandScore: Number(formState.demandScore),
            basePrice: Math.round(Number(formState.basePrice)),
            imageUrl: formState.imageUrl,
            attributes: formState.attributes,
          }),
        });
        await syncAdminPlayerFirestore(res.player).catch(() => {});
        setFeedback({ type: 'success', text: `Updated ${res.player.name} (${res.player.playerCode}).` });
      } else {
        const res = await apiFetch<{ player: CricketPlayer }>('/api/admin/players', {
          method: 'POST',
          body: JSON.stringify({
            name: formState.name.trim(),
            age: Number(formState.age),
            nationality: formState.nationality.trim(),
            isOverseas: formState.isOverseas,
            role: formState.role,
            battingStyle: formState.battingStyle.trim(),
            bowlingStyle: formState.bowlingStyle.trim(),
            experienceLevel: formState.experienceLevel,
            availabilityStatus: formState.availabilityStatus,
            isActive: formState.isActive,
            demandScore: Number(formState.demandScore),
            basePrice: Math.round(Number(formState.basePrice)),
            imageUrl: formState.imageUrl,
            attributes: formState.attributes,
          }),
        });
        await syncAdminPlayerFirestore(res.player).catch(() => {});
        setFeedback({ type: 'success', text: `Created fictional player ${res.player.name} (${res.player.playerCode}).` });
      }
      setFormOpen(false);
      await loadPlayers();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save player.',
      });
    } finally {
      setSavingForm(false);
    }
  };

  const handleToggleActive = async (player: CricketPlayer) => {
    setFeedback(null);
    try {
      const nextActive = !player.isActive;
      const nextStatus: AvailabilityStatus = nextActive ? 'AVAILABLE' : 'INACTIVE';
      const res = await apiFetch<{ player: CricketPlayer }>(`/api/admin/players/${player.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          isActive: nextActive,
          availabilityStatus: nextStatus,
        }),
      });
      await syncAdminPlayerFirestore(res.player).catch(() => {});
      if (detailPlayer?.id === player.id) {
        setDetailPlayer(res.player);
      }
      setFeedback({
        type: 'success',
        text: `${res.player.name} marked ${nextActive ? 'ACTIVE' : 'INACTIVE'}.`,
      });
      await loadPlayers();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to toggle player status.',
      });
    }
  };

  const handleBulkImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setImporting(true);
    setFeedback(null);
    try {
      const parsed = JSON.parse(importText);
      const list = Array.isArray(parsed) ? parsed : parsed?.players;
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error('Provide a non-empty JSON array of fictional players.');
      }
      const res = await apiFetch<{ importedCount: number; players: CricketPlayer[] }>('/api/admin/players/import', {
        method: 'POST',
        body: JSON.stringify({ players: list }),
      });
      for (const p of res.players || []) {
        await syncAdminPlayerFirestore(p).catch(() => {});
      }
      setImportOpen(false);
      setFeedback({ type: 'success', text: `Imported ${res.importedCount} fictional player(s).` });
      await loadPlayers();
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Invalid JSON import payload.',
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Admin Controls */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Cricket Player Database</h1>
          <p className="text-sm text-slate-400">
            <span className="font-mono-num text-amber-400 font-semibold">{players.length}</span> original fictional players
            matched · Role-weighted ratings &amp; independent valuation base prices.
          </p>
        </div>

        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              onClick={openCreateModal}
              className="px-3.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Fictional Player</span>
            </button>
            <button
              onClick={() => setImportOpen(true)}
              className="px-3.5 py-2 rounded-lg bg-[#0B1325] border border-slate-700 hover:border-amber-500/60 text-slate-200 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5 text-amber-400" />
              <span>Bulk JSON Import</span>
            </button>
          </div>
        )}
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-lg border text-xs flex items-center justify-between gap-3 ${
            feedback.type === 'error'
              ? 'bg-red-950/60 border-red-800/80 text-red-200'
              : 'bg-emerald-950/60 border-emerald-800/80 text-emerald-200'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedback.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
            <span>{feedback.text}</span>
          </div>
          <button onClick={() => setFeedback(null)} className="opacity-70 hover:opacity-100 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 8 Category Tabs */}
      <div className="flex items-center gap-1 p-1 bg-[#0B1325] rounded-xl border border-slate-800/80 overflow-x-auto">
        {DATABASE_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3.5 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
              tab === t.id ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Search, Multi-Facet Filters & Sorting */}
      <div className="p-4 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-3">
        <div className="flex flex-col md:flex-row gap-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              loadPlayers();
            }}
            className="flex-1 flex gap-2"
          >
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by player name, ID (e.g. CVP-0001), or nation..."
                className="w-full pl-10 pr-4 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
            >
              Search
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              aria-label="Filter by role"
              className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-xs text-white"
            >
              <option value="ALL">All Roles</option>
              {PLAYING_ROLES.map((r) => (
                <option key={r} value={r}>
                  {PLAYING_ROLE_LABELS[r]}
                </option>
              ))}
            </select>

            <select
              value={nationalityCategory}
              onChange={(e) => setNationalityCategory(e.target.value)}
              aria-label="Filter by nationality category"
              className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-xs text-white"
            >
              <option value="ALL">All Nationalities</option>
              <option value="DOMESTIC">Domestic</option>
              <option value="OVERSEAS">Overseas</option>
            </select>

            <select
              value={minRating}
              onChange={(e) => setMinRating(Number(e.target.value))}
              aria-label="Filter by minimum overall rating"
              className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-xs text-white font-mono-num"
            >
              <option value={0}>Any Rating</option>
              <option value={60}>OVR 60+</option>
              <option value={70}>OVR 70+</option>
              <option value={80}>OVR 80+</option>
              <option value={85}>OVR 85+</option>
            </select>

            <select
              value={availability}
              onChange={(e) => setAvailability(e.target.value)}
              aria-label="Filter by availability"
              className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-xs text-white"
            >
              <option value="ALL">All Availability</option>
              <option value="AVAILABLE">Available</option>
              <option value="INJURED">Injured</option>
            </select>

            <div className="flex items-center gap-1">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'overallRating' | 'basePrice' | 'name')}
                aria-label="Sort players"
                className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-xs text-white"
              >
                <option value="overallRating">Sort: Overall Rating</option>
                <option value="basePrice">Sort: Base Price</option>
                <option value="name">Sort: Name</option>
              </select>
              <button
                type="button"
                onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
                className="p-2 rounded-lg bg-[#060B18] border border-slate-700 text-slate-300 hover:text-white cursor-pointer"
                title={sortDir === 'desc' ? 'Descending' : 'Ascending'}
              >
                <ArrowUpDown className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {isAdmin && (
          <div className="pt-2 border-t border-slate-800/70 flex items-center justify-between text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5 text-amber-400">
              <Shield className="w-3.5 h-3.5" />
              Admin Player Controls Active
            </span>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className="rounded border-slate-600 bg-[#060B18]"
              />
              <span>Show deactivated players</span>
            </label>
          </div>
        )}
      </div>

      {/* Player Grid */}
      {loading ? (
        <div className="p-8 rounded-xl bg-[#0B1325] border border-slate-800 text-sm text-slate-400">
          Loading cricket player registry...
        </div>
      ) : players.length === 0 ? (
        <div className="p-8 rounded-xl bg-[#0B1325] border border-slate-800 text-sm text-slate-400 text-center">
          No fictional players match the selected filters.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {players.map((p) => (
            <div
              key={p.id}
              className={`rounded-xl overflow-hidden bg-[#0B1325] border flex flex-col transition-colors ${
                p.isActive ? 'border-slate-800/80 hover:border-amber-500/40' : 'border-red-900/50 opacity-75'
              }`}
            >
              <div className="relative h-44 bg-[#060B18]">
                <PlayerImage src={p.imageUrl} alt={p.name} className="w-full h-full object-cover object-top" />
                <div className="absolute inset-0 bg-gradient-to-t from-[#0B1325] via-[#0B1325]/25 to-transparent" />

                <div className="absolute top-3 left-3 right-3 flex items-center justify-between text-[11px] font-mono-num">
                  <span className="px-2 py-0.5 rounded bg-[#060B18]/85 border border-slate-700/80 text-slate-200">
                    {p.playerCode}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-[#060B18]/90 border border-amber-500/50 text-amber-400 font-bold">
                    OVR {p.overallRating}
                  </span>
                </div>

                <div className="absolute bottom-3 left-4 right-4 flex items-end justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] text-amber-400 font-medium truncate">
                      {PLAYING_ROLE_LABELS[p.role] || p.role.replace(/_/g, ' ')}
                    </div>
                    <div className="text-base font-display font-bold text-white truncate">{p.name}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] text-slate-400">Base Price</div>
                    <div className="text-xs font-mono-num font-bold text-emerald-400">
                      {formatCurrency(p.basePrice)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-4 flex-1 flex flex-col justify-between gap-3 text-xs">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-slate-400">
                    <span className="truncate">
                      {p.nationality} · {p.isOverseas ? 'Overseas' : 'Domestic'}
                    </span>
                    <span className="text-slate-300 font-medium shrink-0">
                      {EXPERIENCE_LEVEL_LABELS[p.experienceLevel] || p.experienceLevel}
                    </span>
                  </div>

                  <div className="grid grid-cols-4 gap-1.5 pt-2 border-t border-slate-800/80 text-center font-mono-num">
                    <div>
                      <div className="text-[10px] text-slate-500">BAT</div>
                      <div className="font-bold text-white">{p.battingRating}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500">PWR</div>
                      <div className="font-bold text-white">{p.powerHitting}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500">BWL</div>
                      <div className="font-bold text-white">{p.bowlingRating}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500">FLD</div>
                      <div className="font-bold text-white">{p.fieldingRating}</div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
                  <button
                    onClick={() => setDetailPlayer(p)}
                    className="flex-1 py-1.5 px-2.5 rounded-lg bg-[#060B18] border border-slate-700 hover:border-amber-500/60 text-slate-200 font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Eye className="w-3.5 h-3.5 text-amber-400" />
                    <span>Scout Profile</span>
                  </button>

                  {isAdmin && (
                    <>
                      <button
                        onClick={() => openEditModal(p)}
                        className="p-1.5 rounded-lg bg-[#060B18] border border-slate-700 hover:border-amber-500/60 text-slate-300 hover:text-amber-400 cursor-pointer"
                        title="Edit player"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleToggleActive(p)}
                        className={`p-1.5 rounded-lg bg-[#060B18] border cursor-pointer ${
                          p.isActive
                            ? 'border-slate-700 text-emerald-400 hover:border-red-500/60 hover:text-red-400'
                            : 'border-red-800 text-red-400 hover:border-emerald-500/60 hover:text-emerald-400'
                        }`}
                        title={p.isActive ? 'Deactivate player' : 'Activate player'}
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Player Detail & 10-Attribute Scouting Modal */}
      {detailPlayer && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-[#0B1325] border border-slate-700 p-6 space-y-6">
            <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
              <div className="flex items-center gap-4">
                <PlayerImage
                  src={detailPlayer.imageUrl}
                  alt={detailPlayer.name}
                  className="w-20 h-20 rounded-xl object-cover object-top border border-slate-700 shrink-0"
                />
                <div className="space-y-1">
                  <div className="text-xs font-mono-num text-amber-400 flex flex-wrap items-center gap-2">
                    <span>{detailPlayer.playerCode}</span>
                    <span>·</span>
                    <span>{PLAYING_ROLE_LABELS[detailPlayer.role] || detailPlayer.role}</span>
                    <span>·</span>
                    <span>{EXPERIENCE_LEVEL_LABELS[detailPlayer.experienceLevel]}</span>
                  </div>
                  <h2 className="text-xl font-display font-bold text-white">{detailPlayer.name}</h2>
                  <div className="text-xs text-slate-400">
                    {detailPlayer.nationality} ({detailPlayer.isOverseas ? 'Overseas' : 'Domestic'}) · Age{' '}
                    {detailPlayer.age} · {detailPlayer.battingStyle} · {detailPlayer.bowlingStyle}
                  </div>
                </div>
              </div>

              <button
                onClick={() => setDetailPlayer(null)}
                className="p-1.5 rounded-lg bg-[#060B18] border border-slate-700 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Key Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono-num">
              <div className="p-3.5 rounded-xl bg-[#060B18] border border-slate-800">
                <div className="text-[11px] font-sans text-slate-400">Overall Rating</div>
                <div className="text-2xl font-bold text-amber-400">{detailPlayer.overallRating}</div>
              </div>
              <div className="p-3.5 rounded-xl bg-[#060B18] border border-slate-800">
                <div className="text-[11px] font-sans text-slate-400">Base Auction Price</div>
                <div className="text-2xl font-bold text-emerald-400">{formatCurrency(detailPlayer.basePrice)}</div>
              </div>
              <div className="p-3.5 rounded-xl bg-[#060B18] border border-slate-800">
                <div className="text-[11px] font-sans text-slate-400">Availability</div>
                <div className="text-sm font-sans font-bold text-white mt-1">{detailPlayer.availabilityStatus}</div>
              </div>
              <div className="p-3.5 rounded-xl bg-[#060B18] border border-slate-800">
                <div className="text-[11px] font-sans text-slate-400">Demand Index</div>
                <div className="text-2xl font-bold text-sky-400">{detailPlayer.demandScore}</div>
              </div>
            </div>

            {/* 10 Cricket Attributes */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-300">10-Attribute Skill Breakdown (0–100)</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  { label: 'Batting', val: detailPlayer.battingRating },
                  { label: 'Batting Timing', val: detailPlayer.battingTiming },
                  { label: 'Power Hitting', val: detailPlayer.powerHitting },
                  { label: 'Bowling', val: detailPlayer.bowlingRating },
                  { label: 'Bowling Accuracy', val: detailPlayer.bowlingAccuracy },
                  { label: 'Swing', val: detailPlayer.swing },
                  { label: 'Spin', val: detailPlayer.spin },
                  { label: 'Fielding', val: detailPlayer.fieldingRating },
                  { label: 'Stamina', val: detailPlayer.stamina },
                  { label: 'Experience', val: detailPlayer.experienceRating },
                ].map((attr) => (
                  <div key={attr.label} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-300">{attr.label}</span>
                      <span className="font-mono-num font-bold text-white">{attr.val}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[#060B18] overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          attr.val >= 80 ? 'bg-amber-400' : attr.val >= 60 ? 'bg-emerald-500' : 'bg-slate-500'
                        }`}
                        style={{ width: `${Math.min(100, Math.max(0, attr.val))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Valuation Breakdown */}
            {detailPlayer.valuationBreakdown && (
              <div className="p-4 rounded-xl bg-[#060B18] border border-slate-800 space-y-2 text-xs">
                <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  <span>Independent Player Valuation Model</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 font-mono-num text-[11px]">
                  <div>
                    <div className="text-slate-500 font-sans">Role Rarity</div>
                    <div className="text-white font-semibold">
                      {detailPlayer.valuationBreakdown.roleRarityMultiplier}x
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500 font-sans">Experience</div>
                    <div className="text-white font-semibold">
                      {detailPlayer.valuationBreakdown.experienceMultiplier}x
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500 font-sans">Demand</div>
                    <div className="text-white font-semibold">{detailPlayer.valuationBreakdown.demandMultiplier}x</div>
                  </div>
                  <div>
                    <div className="text-slate-500 font-sans">Dual Skill</div>
                    <div className="text-white font-semibold">
                      {detailPlayer.valuationBreakdown.dualCapabilityBonus}x
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500 font-sans">Suggested Base</div>
                    <div className="text-emerald-400 font-bold">
                      {formatCurrency(detailPlayer.valuationBreakdown.suggestedBasePrice)}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Career Season Stats */}
            {detailPlayer.seasonStats && (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 p-4 rounded-xl bg-[#060B18] border border-slate-800 text-xs font-mono-num">
                <div>
                  <div className="text-slate-500 font-sans">Matches</div>
                  <div className="text-white font-bold">{detailPlayer.seasonStats.matchesPlayed}</div>
                </div>
                <div>
                  <div className="text-slate-500 font-sans">Runs</div>
                  <div className="text-white font-bold">{detailPlayer.seasonStats.runs}</div>
                </div>
                <div>
                  <div className="text-slate-500 font-sans">Strike Rate</div>
                  <div className="text-white font-bold">{detailPlayer.seasonStats.strikeRate}</div>
                </div>
                <div>
                  <div className="text-slate-500 font-sans">Wickets</div>
                  <div className="text-white font-bold">{detailPlayer.seasonStats.wickets}</div>
                </div>
                <div>
                  <div className="text-slate-500 font-sans">Economy</div>
                  <div className="text-white font-bold">{(detailPlayer.seasonStats.economyRate / 100).toFixed(2)}</div>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              {isAdmin && (
                <button
                  onClick={() => {
                    const target = detailPlayer;
                    setDetailPlayer(null);
                    openEditModal(target);
                  }}
                  className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
                >
                  Edit Player &amp; Attributes
                </button>
              )}
              <button
                onClick={() => setDetailPlayer(null)}
                className="px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-xs font-semibold cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Add / Edit Player Modal */}
      {formOpen && isAdmin && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleSavePlayer}
            className="w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-2xl bg-[#0B1325] border border-slate-700 p-6 space-y-5"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-lg font-display font-bold text-white">
                  {formState.id ? 'Edit Fictional Player & Attributes' : 'Create Original Fictional Player'}
                </h2>
                <p className="text-xs text-slate-400">
                  Do not enter real cricketer names or copyrighted likenesses.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="p-1.5 rounded-lg bg-[#060B18] border border-slate-700 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
              <div className="sm:col-span-2">
                <label className="block text-slate-400 mb-1">Fictional Player Name *</label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={60}
                  value={formState.name}
                  onChange={(e) => setFormState((f) => ({ ...f, name: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Age (16–48)</label>
                <input
                  type="number"
                  min={16}
                  max={48}
                  value={formState.age}
                  onChange={(e) => setFormState((f) => ({ ...f, age: Number(e.target.value) }))}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Nationality *</label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={40}
                  value={formState.nationality}
                  onChange={(e) => {
                    const nat = e.target.value;
                    setFormState((f) => ({
                      ...f,
                      nationality: nat,
                      isOverseas: nat.trim().toLowerCase() !== 'india',
                    }));
                  }}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Playing Role</label>
                <select
                  value={formState.role}
                  onChange={(e) => setFormState((f) => ({ ...f, role: e.target.value as PlayingRole }))}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
                >
                  {PLAYING_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {PLAYING_ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Experience Level</label>
                <select
                  value={formState.experienceLevel}
                  onChange={(e) =>
                    setFormState((f) => ({ ...f, experienceLevel: e.target.value as ExperienceLevel }))
                  }
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
                >
                  {EXPERIENCE_LEVELS.map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {EXPERIENCE_LEVEL_LABELS[lvl]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Batting Style</label>
                <input
                  type="text"
                  required
                  value={formState.battingStyle}
                  onChange={(e) => setFormState((f) => ({ ...f, battingStyle: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Bowling Style</label>
                <input
                  type="text"
                  required
                  value={formState.bowlingStyle}
                  onChange={(e) => setFormState((f) => ({ ...f, bowlingStyle: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Availability</label>
                <select
                  value={formState.availabilityStatus}
                  onChange={(e) => {
                    const status = e.target.value as AvailabilityStatus;
                    setFormState((f) => ({
                      ...f,
                      availabilityStatus: status,
                      isActive: status !== 'INACTIVE',
                    }));
                  }}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
                >
                  {AVAILABILITY_OPTIONS.map((av) => (
                    <option key={av} value={av}>
                      {av}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Avatar Upload & Presets */}
            <div className="p-4 rounded-xl bg-[#060B18] border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs">
              <div className="flex items-center gap-3">
                <PlayerImage
                  src={formState.imageUrl}
                  alt="Avatar preview"
                  className="w-14 h-14 rounded-lg object-cover border border-slate-700"
                />
                <div>
                  <div className="font-semibold text-white">Original Player Avatar</div>
                  <div className="text-slate-400">Upload an original avatar or pick a studio portrait.</div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={AVATAR_PRESETS.some((p) => p.url === formState.imageUrl) ? formState.imageUrl : ''}
                  onChange={(e) => {
                    if (e.target.value) setFormState((f) => ({ ...f, imageUrl: e.target.value }));
                  }}
                  className="px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-white"
                >
                  <option value="">Custom Uploaded Image</option>
                  {AVATAR_PRESETS.map((p) => (
                    <option key={p.url} value={p.url}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <label className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold cursor-pointer inline-flex items-center gap-1.5">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Upload File</span>
                  <input type="file" accept="image/*" onChange={handleAvatarUpload} className="hidden" />
                </label>
              </div>
            </div>

            {/* 10 Attributes Sliders */}
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-200">Player Attributes (0–100)</span>
                <span className="font-mono-num text-amber-400 font-bold">
                  Live Role-Weighted OVR: {liveOverallRating}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                {ATTRIBUTE_FIELDS.map((field) => (
                  <div key={field.key} className="p-2.5 rounded-lg bg-[#060B18] border border-slate-800 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-300">{field.label}</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={formState.attributes[field.key]}
                        onChange={(e) =>
                          setFormState((f) => ({
                            ...f,
                            attributes: { ...f.attributes, [field.key]: clampAttr(Number(e.target.value)) },
                          }))
                        }
                        className="w-16 px-2 py-0.5 rounded bg-[#0B1325] border border-slate-700 text-right font-mono-num text-white"
                      />
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={formState.attributes[field.key]}
                      onChange={(e) =>
                        setFormState((f) => ({
                          ...f,
                          attributes: { ...f.attributes, [field.key]: clampAttr(Number(e.target.value)) },
                        }))
                      }
                      className="w-full accent-amber-500"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Valuation & Base Price */}
            <div className="p-4 rounded-xl bg-[#060B18] border border-slate-800 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end text-xs">
              <div>
                <label className="block text-slate-400 mb-1">Market Demand Score (70–140)</label>
                <input
                  type="number"
                  min={70}
                  max={140}
                  value={formState.demandScore}
                  onChange={(e) => setFormState((f) => ({ ...f, demandScore: Number(e.target.value) }))}
                  className="w-full px-3 py-2 rounded-lg bg-[#0B1325] border border-slate-700 text-white font-mono-num"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Base Auction Price (Integer Lakhs)</label>
                <input
                  type="number"
                  min={10}
                  max={2000}
                  step={5}
                  value={formState.basePrice}
                  onChange={(e) => setFormState((f) => ({ ...f, basePrice: Number(e.target.value) }))}
                  className="w-full px-3 py-2 rounded-lg bg-[#0B1325] border border-slate-700 text-emerald-400 font-bold font-mono-num"
                />
              </div>
              <button
                type="button"
                onClick={() => setFormState((f) => ({ ...f, basePrice: liveValuation.suggestedBasePrice }))}
                className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Recalculate ({formatCurrency(liveValuation.suggestedBasePrice)})</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800">
              <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formState.isOverseas}
                  onChange={(e) => setFormState((f) => ({ ...f, isOverseas: e.target.checked }))}
                  className="rounded border-slate-600 bg-[#060B18]"
                />
                <span>Overseas Player</span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingForm}
                  className="px-5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
                >
                  {savingForm ? 'Saving...' : formState.id ? 'Update Player' : 'Create Player'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Bulk JSON Import Modal */}
      {importOpen && isAdmin && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleBulkImport}
            className="w-full max-w-2xl rounded-2xl bg-[#0B1325] border border-slate-700 p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-lg font-display font-bold text-white">Bulk Import Fictional Players</h2>
                <p className="text-xs text-slate-400">
                  Paste a JSON array of original fictional players. Ratings &amp; integer base prices auto-compute if omitted.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setImportOpen(false)}
                className="p-1.5 rounded-lg bg-[#060B18] border border-slate-700 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              rows={12}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              className="w-full p-3 rounded-xl bg-[#060B18] border border-slate-700 text-xs font-mono-num text-slate-200"
            />

            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setImportText(SAMPLE_IMPORT_JSON)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-xs cursor-pointer"
              >
                Load Fictional Sample JSON
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setImportOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={importing}
                  className="px-5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
                >
                  {importing ? 'Importing...' : 'Import Players'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
