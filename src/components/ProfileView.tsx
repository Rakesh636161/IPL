import React, { useEffect, useState } from 'react';
import {
  Calendar,
  Check,
  Copy,
  Gavel,
  Lock,
  Mail,
  Save,
  ShieldCheck,
  Trophy,
  UserCheck,
  UserCircle2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { syncUserStatisticsInFirestore } from '../services/firestoreService.ts';
import { UserStatistics, formatCurrency } from '../types/cricketverse.ts';

interface ProfileViewProps {
  onNavigate: (tab: string, leagueId?: string) => void;
}

const PRESET_AVATARS = [
  {
    label: 'Striker',
    url: '/src/assets/images/player_batsman_portrait_1794578454251.jpg',
  },
  {
    label: 'Paceman',
    url: '/src/assets/images/player_bowler_portrait_1794578454903.jpg',
  },
  {
    label: 'Keeper',
    url: '/src/assets/images/player_keeper_portrait_1794578452592.jpg',
  },
  {
    label: 'Auctioneer',
    url: '/src/assets/images/auction_gavel_gold_1794578451590.jpg',
  },
];

export const ProfileView: React.FC<ProfileViewProps> = ({ onNavigate }) => {
  const {
    firebaseUser,
    dbUser,
    firestoreProfile,
    firestoreStats,
    apiFetch,
    updateUserProfile,
    sendVerificationEmail,
  } = useAuth();

  const [stats, setStats] = useState<UserStatistics | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [copied, setCopied] = useState(false);

  const [username, setUsername] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [country, setCountry] = useState('Global');
  const [bio, setBio] = useState('Franchise Owner');
  const [preferredRole, setPreferredRole] = useState('Tactician');

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [verificationNotice, setVerificationNotice] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);

  const uniquePlayerId =
    firestoreProfile?.uniquePlayerId || dbUser?.profile?.uniquePlayerId || 'Assigning...';

  useEffect(() => {
    const activeName =
      firestoreProfile?.username ||
      dbUser?.profile?.displayName ||
      firebaseUser?.displayName ||
      'Franchise Owner';
    const activePhoto =
      firestoreProfile?.photoUrl ??
      dbUser?.profile?.avatarUrl ??
      firebaseUser?.photoURL ??
      '';
    setUsername(activeName);
    setAvatarUrl(activePhoto || '');
    setCountry(firestoreProfile?.country || dbUser?.profile?.country || 'Global');
    setBio(firestoreProfile?.bio || dbUser?.profile?.bio || 'Franchise Owner');
    setPreferredRole(
      firestoreProfile?.preferredRole || dbUser?.profile?.preferredRole || 'Tactician'
    );
    setImageError(false);
  }, [dbUser, firestoreProfile, firebaseUser]);

  useEffect(() => {
    let active = true;
    const loadStats = async () => {
      setLoadingStats(true);
      try {
        const res = await apiFetch<{ stats: UserStatistics }>('/api/me/stats');
        if (active) {
          setStats(res.stats);
          if (firebaseUser?.uid) {
            void syncUserStatisticsInFirestore(firebaseUser.uid, res.stats).catch(() => undefined);
          }
        }
      } catch {
        // fallback to Firestore real-time stats if available
      } finally {
        if (active) setLoadingStats(false);
      }
    };
    loadStats();
    return () => {
      active = false;
    };
  }, [apiFetch]);

  const effectiveStats = {
    totalMatches: stats?.totalMatches ?? firestoreStats?.totalMatches ?? 0,
    totalWins: stats?.totalWins ?? firestoreStats?.totalWins ?? 0,
    totalTournaments: stats?.totalTournaments ?? firestoreStats?.totalTournaments ?? 0,
    auctionsParticipated:
      stats?.auctionsParticipated ?? firestoreStats?.auctionsParticipated ?? 0,
    playersAcquired: stats?.playersAcquired ?? firestoreStats?.playersAcquired ?? 0,
    totalSpent: stats?.totalSpent ?? firestoreStats?.totalSpent ?? 0,
    auctionHistory: stats?.auctionHistory ?? firestoreStats?.auctionHistory ?? [],
  };

  const registrationDateRaw =
    stats?.registrationDate ||
    dbUser?.createdAt ||
    firestoreProfile?.createdAt ||
    firebaseUser?.metadata?.creationTime;

  const formattedRegistrationDate = registrationDateRaw
    ? new Date(registrationDateRaw).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : 'Recently joined';

  const copyPlayerId = () => {
    if (!uniquePlayerId || uniquePlayerId === 'Assigning...') return;
    navigator.clipboard.writeText(uniquePlayerId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    setSaveMessage(null);

    const trimmedName = username.trim();
    if (trimmedName.length < 2 || trimmedName.length > 40) {
      setSaveError('Username must be between 2 and 40 characters.');
      return;
    }

    const trimmedAvatar = avatarUrl.trim();
    if (
      trimmedAvatar &&
      !trimmedAvatar.startsWith('https://') &&
      !trimmedAvatar.startsWith('http://') &&
      !trimmedAvatar.startsWith('/src/assets/')
    ) {
      setSaveError('Profile picture must be a valid HTTP(S) URL or a CricketVerse preset.');
      return;
    }

    setSaving(true);
    try {
      await updateUserProfile({
        displayName: trimmedName,
        avatarUrl: trimmedAvatar || null,
        country: country.trim() || 'Global',
        bio: bio.trim() || 'Franchise Owner',
        preferredRole: preferredRole.trim() || 'Tactician',
      });
      setSaveMessage('Profile saved to Firebase & CricketVerse directory.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to update profile.');
    } finally {
      setSaving(false);
    }
  };

  const handleSendVerification = async () => {
    setVerificationNotice(null);
    try {
      await sendVerificationEmail();
      setVerificationNotice('Verification email sent. Check your inbox and refresh once verified.');
    } catch (err) {
      setVerificationNotice(
        err instanceof Error ? err.message : 'Unable to send verification email right now.'
      );
    }
  };

  const winRate =
    effectiveStats.totalMatches > 0
      ? Math.round((effectiveStats.totalWins / effectiveStats.totalMatches) * 100)
      : 0;

  return (
    <div className="space-y-8">
      {/* Identity Overview Banner */}
      <section className="rounded-xl bg-[#0B1325] border border-slate-800/80 overflow-hidden">
        <div className="p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-5">
            <div className="w-24 h-24 rounded-2xl overflow-hidden bg-[#060B18] border-2 border-amber-500/60 shrink-0 flex items-center justify-center">
              {avatarUrl && !imageError ? (
                <img
                  src={avatarUrl}
                  alt={username || 'Profile Picture'}
                  referrerPolicy="no-referrer"
                  onError={() => setImageError(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <UserCircle2 className="w-12 h-12 text-amber-400/80" />
              )}
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-2xl sm:text-3xl font-display font-bold text-white">
                  {dbUser?.profile?.displayName || username || 'Franchise Owner'}
                </h1>
                <span className="px-2.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-semibold">
                  {dbUser?.profile?.onlineStatus || 'ONLINE'}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-300">
                <span className="flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-slate-400" />
                  <span>{dbUser?.email || firebaseUser?.email}</span>
                  {firebaseUser?.emailVerified ? (
                    <span className="text-emerald-400 font-semibold flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      Verified
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSendVerification}
                      className="text-amber-400 hover:underline cursor-pointer"
                    >
                      Verify Email
                    </button>
                  )}
                </span>
                <span className="flex items-center gap-1.5 text-slate-400">
                  <Calendar className="w-3.5 h-3.5" />
                  <span>Joined {formattedRegistrationDate}</span>
                </span>
              </div>

              {verificationNotice && (
                <div className="text-xs text-amber-300">{verificationNotice}</div>
              )}
            </div>
          </div>

          {/* Immutable Unique Player ID Card */}
          <div className="p-4 rounded-xl bg-[#060B18] border border-amber-500/40 flex flex-col gap-2 min-w-[240px]">
            <div className="flex items-center justify-between text-[11px] text-slate-400 uppercase tracking-wider font-semibold">
              <span>Unique Player ID</span>
              <span className="flex items-center gap-1 text-amber-400">
                <Lock className="w-3 h-3" />
                Permanent
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xl font-mono-num font-bold text-amber-400 tracking-wide">
                {uniquePlayerId}
              </span>
              <button
                type="button"
                onClick={copyPlayerId}
                className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <p className="text-[11px] text-slate-500">
              Share this ID with friends so they can find and challenge you.
            </p>
          </div>
        </div>
      </section>

      {/* Career Statistics Grid */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-[#0B1325] border border-slate-800/80">
          <div className="text-xs text-slate-400">Total Matches</div>
          <div className="mt-1 text-2xl font-mono-num font-bold text-white">
            {loadingStats ? '...' : effectiveStats.totalMatches}
          </div>
          <div className="mt-1 text-xs text-slate-400">Completed fixtures</div>
        </div>

        <div className="p-4 rounded-xl bg-[#0B1325] border border-slate-800/80">
          <div className="text-xs text-slate-400">Total Wins</div>
          <div className="mt-1 text-2xl font-mono-num font-bold text-emerald-400">
            {loadingStats ? '...' : effectiveStats.totalWins}
          </div>
          <div className="mt-1 text-xs text-slate-400 font-mono-num">{winRate}% win rate</div>
        </div>

        <div className="p-4 rounded-xl bg-[#0B1325] border border-slate-800/80">
          <div className="text-xs text-slate-400">Total Tournaments</div>
          <div className="mt-1 text-2xl font-mono-num font-bold text-amber-400">
            {loadingStats ? '...' : effectiveStats.totalTournaments}
          </div>
          <div className="mt-1 text-xs text-slate-400">Leagues entered</div>
        </div>

        <div className="p-4 rounded-xl bg-[#0B1325] border border-slate-800/80">
          <div className="text-xs text-slate-400">Auctions &amp; Signings</div>
          <div className="mt-1 text-2xl font-mono-num font-bold text-white">
            {loadingStats ? '...' : effectiveStats.auctionsParticipated}
          </div>
          <div className="mt-1 text-xs text-slate-400 font-mono-num">
            {effectiveStats.playersAcquired} players · {formatCurrency(effectiveStats.totalSpent)}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Edit Profile Form */}
        <section className="lg:col-span-5 p-6 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-display font-semibold text-white flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-amber-400" />
              <span>Edit Profile</span>
            </h2>
            <span className="text-xs text-slate-400">Synced with Firebase</span>
          </div>

          <form onSubmit={handleSave} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Username / Owner Name
              </label>
              <input
                type="text"
                required
                minLength={2}
                maxLength={40}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#060B18] border border-slate-800 text-sm text-white focus:outline-none focus:border-amber-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Profile Picture URL
              </label>
              <input
                type="text"
                value={avatarUrl}
                onChange={(e) => {
                  setAvatarUrl(e.target.value);
                  setImageError(false);
                }}
                placeholder="https://... or select a CricketVerse avatar below"
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#060B18] border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
              />
              <div className="mt-2.5 grid grid-cols-4 gap-2">
                {PRESET_AVATARS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setAvatarUrl(preset.url);
                      setImageError(false);
                    }}
                    className={`p-1.5 rounded-lg border text-center transition-colors cursor-pointer ${
                      avatarUrl === preset.url
                        ? 'border-amber-500 bg-amber-500/10'
                        : 'border-slate-800 bg-[#060B18] hover:border-slate-700'
                    }`}
                  >
                    <img
                      src={preset.url}
                      alt={preset.label}
                      referrerPolicy="no-referrer"
                      className="w-full h-11 object-cover rounded"
                    />
                    <span className="mt-1 block text-[10px] text-slate-300">{preset.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Region / Country
                </label>
                <input
                  type="text"
                  maxLength={40}
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#060B18] border border-slate-800 text-sm text-white focus:outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Preferred Style
                </label>
                <select
                  value={preferredRole}
                  onChange={(e) => setPreferredRole(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-lg bg-[#060B18] border border-slate-800 text-sm text-white focus:outline-none focus:border-amber-500"
                >
                  <option value="Tactician">Tactician</option>
                  <option value="Aggressive Bidder">Aggressive Bidder</option>
                  <option value="Moneyball Strategist">Moneyball Strategist</option>
                  <option value="All-Round Builder">All-Round Builder</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Franchise Motto
              </label>
              <input
                type="text"
                maxLength={160}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                className="w-full px-3.5 py-2 rounded-lg bg-[#060B18] border border-slate-800 text-sm text-white focus:outline-none focus:border-amber-500"
              />
            </div>

            {saveError && (
              <div className="p-3 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200">
                {saveError}
              </div>
            )}
            {saveMessage && (
              <div className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-700/70 text-xs text-emerald-200">
                {saveMessage}
              </div>
            )}

            <button
              type="submit"
              disabled={saving}
              className="w-full py-2.5 px-4 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold flex items-center justify-center gap-2 transition-colors disabled:opacity-60 cursor-pointer"
            >
              <Save className="w-4 h-4" />
              <span>{saving ? 'Saving Changes...' : 'Save Profile Changes'}</span>
            </button>
          </form>
        </section>

        {/* Auction Participation History */}
        <section className="lg:col-span-7 p-6 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-display font-semibold text-white flex items-center gap-2">
              <Gavel className="w-4 h-4 text-amber-400" />
              <span>Auction Participation History</span>
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('leagues')}
              className="text-xs font-medium text-amber-400 hover:text-amber-300 cursor-pointer"
            >
              Browse Leagues
            </button>
          </div>

          {loadingStats ? (
            <div className="py-10 text-center text-xs text-slate-400">
              Loading auction participation ledger...
            </div>
          ) : effectiveStats.auctionHistory.length === 0 ? (
            <div className="p-6 rounded-lg bg-[#060B18] border border-slate-800/80 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Trophy className="w-4 h-4 text-amber-400" />
                <span>No Completed or Live Auctions Yet</span>
              </div>
              <p className="text-xs text-slate-400">
                Join or host a league and start an auction to record your signings, purse efficiency, and championship participation here.
              </p>
              <button
                type="button"
                onClick={() => onNavigate('leagues')}
                className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
              >
                Enter League Lobby
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {effectiveStats.auctionHistory.map((item) => (
                <div
                  key={item.leagueId}
                  className="p-4 rounded-lg bg-[#060B18] border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{item.leagueName}</span>
                      <span className="text-[11px] font-mono-num text-amber-400">
                        {item.auctionState}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 font-mono-num">
                      {item.teamName} ({item.teamShortName}) · {item.playersWon} signed · Spent{' '}
                      {formatCurrency(item.totalSpent)} · Left{' '}
                      {formatCurrency(item.remainingPurse)}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] text-slate-500">
                      {new Date(item.participatedAt).toLocaleDateString()}
                    </span>
                    <button
                      type="button"
                      onClick={() => onNavigate('auction', item.leagueId)}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white cursor-pointer"
                    >
                      View Room
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
