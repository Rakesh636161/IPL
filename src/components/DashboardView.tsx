import React, { useEffect, useState } from 'react';
import { Bell, Check, Copy, Gavel, Plus, Shield, Swords, Trophy, Users } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { FriendEntry, LeagueSummary, TeamRecord, formatCurrency } from '../types/cricketverse.ts';

interface DashboardViewProps {
  onNavigate: (tab: string, leagueId?: string) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({ onNavigate }) => {
  const { dbUser, notifications, apiFetch, updateUserProfile, markNotificationRead } = useAuth();
  const [myLeagues, setMyLeagues] = useState<LeagueSummary[]>([]);
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [myTeams, setMyTeams] = useState<TeamRecord[]>([]);
  const [copied, setCopied] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [displayName, setDisplayName] = useState(dbUser?.profile?.displayName || '');
  const [country, setCountry] = useState(dbUser?.profile?.country || 'Global');
  const [bio, setBio] = useState(dbUser?.profile?.bio || 'Franchise Owner');
  const [savingProfile, setSavingProfile] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setDisplayName(dbUser?.profile?.displayName || '');
    setCountry(dbUser?.profile?.country || 'Global');
    setBio(dbUser?.profile?.bio || 'Franchise Owner');
  }, [dbUser]);

  const loadDashboard = async () => {
    setLoading(true);
    try {
      const [leaguesRes, friendsRes, teamsRes] = await Promise.all([
        apiFetch<{ myLeagues: LeagueSummary[] }>('/api/leagues'),
        apiFetch<{ accepted: FriendEntry[] }>('/api/friends'),
        apiFetch<{ teams: TeamRecord[] }>('/api/teams/mine'),
      ]);
      setMyLeagues(leaguesRes.myLeagues || []);
      setFriends(friendsRes.accepted || []);
      setMyTeams(teamsRes.teams || []);
    } catch {
      // handled gracefully in empty state
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDashboard();
  }, []);

  const copyPlayerId = () => {
    if (!dbUser?.profile?.uniquePlayerId) return;
    navigator.clipboard.writeText(dbUser.profile.uniquePlayerId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      await updateUserProfile({ displayName, country, bio });
      setEditingProfile(false);
    } finally {
      setSavingProfile(false);
    }
  };

  const markRead = async (id: string) => {
    await markNotificationRead(id);
  };

  const onlineFriends = friends.filter((f) => f.onlineStatus !== 'OFFLINE');
  const liveAuctions = myLeagues.filter(
    (l) => l.status === 'AUCTION_IN_PROGRESS' || l.status === 'AUCTION_LIVE' || l.status === 'PAUSED'
  );

  return (
    <div className="space-y-8">
      {/* Hero Banner */}
      <section className="relative rounded-xl overflow-hidden border border-slate-800/80 bg-[#0B1325]">
        <img
          src="/src/assets/images/cricket_stadium_night_1794578450905.jpg"
          alt="CricketVerse Arena"
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover opacity-25"
        />
        <div className="relative z-10 p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="space-y-2 max-w-2xl">
            <div className="flex flex-wrap items-center gap-2 text-xs text-amber-400 font-medium">
              <span>Franchise Command</span>
              <span aria-hidden="true">·</span>
              <span>{dbUser?.profile?.country || 'Global'}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-num text-slate-300">
                {dbUser?.profile?.uniquePlayerId || 'Assigning ID...'}
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-display font-bold text-white [text-wrap:balance]">
              Welcome back, {dbUser?.profile?.displayName || 'Franchise Owner'}
            </h1>
            <p className="text-sm text-slate-300">
              {dbUser?.profile?.bio || 'Build your squad in real-time 2–12 team auctions and compete for the championship.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              onClick={copyPlayerId}
              className="px-3.5 py-2 rounded-lg bg-[#060B18]/90 border border-slate-700 hover:border-amber-500/60 text-xs font-mono-num text-slate-200 flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-amber-400" />}
              <span>{copied ? 'ID Copied' : dbUser?.profile?.uniquePlayerId || 'Copy ID'}</span>
            </button>

            <button
              onClick={() => onNavigate('profile')}
              className="px-3.5 py-2 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              My Profile
            </button>

            <button
              onClick={() => setEditingProfile((v) => !v)}
              className="px-3.5 py-2 rounded-lg bg-slate-800/90 hover:bg-slate-700 text-xs font-semibold text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {editingProfile ? 'Close Editor' : 'Quick Edit'}
            </button>

            <button
              onClick={() => onNavigate('leagues')}
              className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Create / Join League</span>
            </button>
          </div>
        </div>

        {editingProfile && (
          <form
            onSubmit={handleSaveProfile}
            className="relative z-10 border-t border-slate-800/90 bg-[#070C1A]/95 p-6 grid grid-cols-1 sm:grid-cols-3 gap-4"
          >
            <div>
              <label className="block text-xs text-slate-400 mb-1">Owner Name</label>
              <input
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#0B1325] border border-slate-700 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Region / Country</label>
              <input
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#0B1325] border border-slate-700 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Franchise Motto</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg bg-[#0B1325] border border-slate-700 text-sm text-white"
                />
                <button
                  type="submit"
                  disabled={savingProfile}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {savingProfile ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </form>
        )}
      </section>

      {/* Key Metrics Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-[#0B1325] border border-slate-800/80">
          <div className="text-xs text-slate-400">Active Leagues</div>
          <div className="mt-1 text-2xl font-mono-num font-bold text-white">{myLeagues.length}</div>
          <div className="mt-1 text-xs text-amber-400">
            {liveAuctions.length > 0 ? `${liveAuctions.length} auction live` : 'Ready to draft'}
          </div>
        </div>
        <div className="p-4 rounded-xl bg-[#0B1325] border border-slate-800/80">
          <div className="text-xs text-slate-400">Owned Franchises</div>
          <div className="mt-1 text-2xl font-mono-num font-bold text-white">{myTeams.length}</div>
          <div className="mt-1 text-xs text-slate-400">
            {myTeams.reduce((acc, t) => acc + t.squadCount, 0)} signed players
          </div>
        </div>
        <div className="p-4 rounded-xl bg-[#0B1325] border border-slate-800/80">
          <div className="text-xs text-slate-400">Friends Online</div>
          <div className="mt-1 text-2xl font-mono-num font-bold text-white">
            {onlineFriends.length} <span className="text-sm text-slate-500">/ {friends.length}</span>
          </div>
          <div className="mt-1 text-xs text-emerald-400">Ready for league invites</div>
        </div>
        <div className="p-4 rounded-xl bg-[#0B1325] border border-slate-800/80">
          <div className="text-xs text-slate-400">Unread Alerts</div>
          <div className="mt-1 text-2xl font-mono-num font-bold text-white">
            {notifications.filter((n) => !n.isRead).length}
          </div>
          <div className="mt-1 text-xs text-slate-400">Invites &amp; requests</div>
        </div>
      </section>

      {/* Main Workspace Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* My Leagues & Live Auction Access */}
        <div className="lg:col-span-8 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-display font-semibold text-white">Your Leagues &amp; Auctions</h2>
            <button
              onClick={() => onNavigate('leagues')}
              className="text-xs font-medium text-amber-400 hover:text-amber-300 cursor-pointer"
            >
              Manage All Leagues
            </button>
          </div>

          {loading ? (
            <div className="p-8 rounded-xl bg-[#0B1325] border border-slate-800/80 text-sm text-slate-400">
              Loading franchise telemetry...
            </div>
          ) : myLeagues.length === 0 ? (
            <div className="p-8 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-3">
              <p className="text-sm text-slate-300">
                You have not joined a cricket league yet. Create a 2–12 team league or enter an invitation code to enter the auction room.
              </p>
              <button
                onClick={() => onNavigate('leagues')}
                className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
              >
                Create Your First League
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {myLeagues.map((league) => {
                const team = myTeams.find((t) => t.leagueId === league.id);
                return (
                  <div
                    key={league.id}
                    className="p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 flex flex-col justify-between gap-4"
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span>{league.visibility} · {league.auctionMode}</span>
                        <span className="font-mono-num text-amber-400">{league.inviteCode}</span>
                      </div>
                      <h3 className="text-base font-display font-bold text-white truncate">
                        {league.name}
                      </h3>
                      <div className="text-xs text-slate-400 flex items-center gap-2 font-mono-num">
                        <span>{league.memberCount ?? 1}/{league.maxTeams} teams</span>
                        <span aria-hidden="true">·</span>
                        <span>Purse {formatCurrency(league.purseAmount)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{league.status}</span>
                      </div>
                    </div>

                    {team && (
                      <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs">
                        <span className="text-slate-300 font-medium">
                          {team.name} ({team.shortName})
                        </span>
                        <span className="font-mono-num text-emerald-400">
                          {formatCurrency(team.remainingPurse)} left · {team.squadCount} players
                        </span>
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      {league.status !== 'CANCELLED' ? (
                        <button
                          onClick={() => onNavigate('auction', league.id)}
                          className="flex-1 py-2 px-3 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer"
                        >
                          <Gavel className="w-3.5 h-3.5" />
                          <span>Enter Auction</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => onNavigate('leagues', league.id)}
                          className="flex-1 py-2 px-3 rounded-lg bg-slate-800 text-slate-400 text-xs font-semibold flex items-center justify-center whitespace-nowrap cursor-pointer"
                        >
                          Cancelled
                        </button>
                      )}
                      <button
                        onClick={() => onNavigate('team', league.id)}
                        className="py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold whitespace-nowrap cursor-pointer"
                      >
                        Squad
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Quick Play Modes */}
          <div className="pt-2">
            <h2 className="text-lg font-display font-semibold text-white mb-3">Match Modes</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <button
                onClick={() => onNavigate('matches')}
                className="p-4 rounded-xl bg-[#0B1325] hover:bg-[#101B33] border border-slate-800/80 text-left transition-colors space-y-1.5 cursor-pointer"
              >
                <Swords className="w-5 h-5 text-amber-400" />
                <div className="text-sm font-semibold text-white">Play Against AI</div>
                <div className="text-xs text-slate-400">Test your drafted Playing XI against AI squads.</div>
              </button>
              <button
                onClick={() => onNavigate('matches')}
                className="p-4 rounded-xl bg-[#0B1325] hover:bg-[#101B33] border border-slate-800/80 text-left transition-colors space-y-1.5 cursor-pointer"
              >
                <Shield className="w-5 h-5 text-emerald-400" />
                <div className="text-sm font-semibold text-white">1v1 Franchise Duel</div>
                <div className="text-xs text-slate-400">Challenge another franchise in your league.</div>
              </button>
              <button
                onClick={() => onNavigate('matches')}
                className="p-4 rounded-xl bg-[#0B1325] hover:bg-[#101B33] border border-slate-800/80 text-left transition-colors space-y-1.5 cursor-pointer"
              >
                <Trophy className="w-5 h-5 text-sky-400" />
                <div className="text-sm font-semibold text-white">Tournament Table</div>
                <div className="text-xs text-slate-400">Simulate league fixtures and view NRR standings.</div>
              </button>
            </div>
          </div>
        </div>

        {/* Right Rail: Friends Online & Notifications */}
        <div className="lg:col-span-4 space-y-6">
          <div className="p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-display font-semibold text-white flex items-center gap-2">
                <Users className="w-4 h-4 text-emerald-400" />
                <span>Friends Roster</span>
              </h3>
              <button
                onClick={() => onNavigate('friends')}
                className="text-xs text-amber-400 hover:text-amber-300 cursor-pointer"
              >
                Add Friends
              </button>
            </div>

            {friends.length === 0 ? (
              <p className="text-xs text-slate-400">
                No friends added yet. Search owners by Unique Player ID to build your rival network.
              </p>
            ) : (
              <ul className="divide-y divide-slate-800/80">
                {friends.slice(0, 6).map((f) => (
                  <li key={f.friendshipId} className="py-2.5 flex items-center justify-between text-xs">
                    <div>
                      <div className="font-medium text-slate-200">{f.displayName}</div>
                      <div className="text-slate-500 font-mono-num">{f.uniquePlayerId}</div>
                    </div>
                    <span
                      className={`font-medium ${
                        f.onlineStatus === 'IN_AUCTION'
                          ? 'text-amber-400'
                          : f.onlineStatus === 'ONLINE'
                          ? 'text-emerald-400'
                          : 'text-slate-500'
                      }`}
                    >
                      {f.onlineStatus}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-display font-semibold text-white flex items-center gap-2">
                <Bell className="w-4 h-4 text-amber-400" />
                <span>Notifications</span>
              </h3>
            </div>

            {notifications.length === 0 ? (
              <p className="text-xs text-slate-400">No league invitations or friend alerts.</p>
            ) : (
              <ul className="space-y-3 max-h-72 overflow-y-auto pr-1">
                {notifications.slice(0, 8).map((n) => (
                  <li
                    key={n.id}
                    className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                      n.isRead
                        ? 'bg-[#070D1C] border-slate-800/60 text-slate-400'
                        : 'bg-[#0E1933] border-amber-500/30 text-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-white">{n.title}</span>
                      {!n.isRead && (
                        <button
                          onClick={() => markRead(n.id)}
                          className="text-[11px] text-amber-400 hover:underline cursor-pointer"
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                    <p>{n.message}</p>
                    {n.metadata?.leagueId && (
                      <button
                        onClick={() => onNavigate('leagues', n.metadata?.leagueId)}
                        className="text-amber-400 font-semibold hover:underline cursor-pointer"
                      >
                        Open League Lobby
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
