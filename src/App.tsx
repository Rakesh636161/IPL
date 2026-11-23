import React, { useState } from 'react';
import { LogOut, Menu, UserCircle2, X } from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { ProtectedRoute } from './components/ProtectedRoute.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { LeaguesView } from './components/LeaguesView.tsx';
import { AuctionRoomView } from './components/AuctionRoomView.tsx';
import { TeamManagerView } from './components/TeamManagerView.tsx';
import { FriendsView } from './components/FriendsView.tsx';
import { PlayersDatabaseView } from './components/PlayersDatabaseView.tsx';
import { MatchCenterView } from './components/MatchCenterView.tsx';
import { ProfileView } from './components/ProfileView.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';

type NavTab =
  | 'dashboard'
  | 'leagues'
  | 'auction'
  | 'team'
  | 'friends'
  | 'players'
  | 'matches'
  | 'profile';

const AppShell: React.FC = () => {
  const { dbUser, logout } = useAuth();
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('invite');
      return code ? code.trim().toUpperCase() : null;
    } catch {
      return null;
    }
  });
  const [activeTab, setActiveTab] = useState<NavTab>(() => (pendingInviteCode ? 'leagues' : 'dashboard'));
  const [selectedLeagueId, setSelectedLeagueId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navigate = (tab: string, leagueId?: string) => {
    if (leagueId) setSelectedLeagueId(leagueId);
    setActiveTab(tab as NavTab);
    setMobileMenuOpen(false);
  };

  const clearPendingInviteCode = () => {
    setPendingInviteCode(null);
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('invite')) {
        url.searchParams.delete('invite');
        window.history.replaceState({}, '', url.pathname + url.search);
      }
    } catch {
      // ignore history update failure
    }
  };

  const navLinks: Array<{ id: NavTab; label: string }> = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'leagues', label: 'Leagues' },
    { id: 'auction', label: 'Auction' },
    { id: 'team', label: 'My Squad' },
    { id: 'players', label: 'Players' },
  ];

  return (
    <div className="min-h-screen bg-[#060B18] text-slate-100 flex flex-col">
      {/* 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-40 bg-[#060B18]/95 backdrop-blur border-b border-slate-800/80">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6">
          {/* Zone 1: Single-line Wordmark */}
          <button
            onClick={() => navigate('dashboard')}
            className="text-xl font-display font-bold tracking-tight text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            CricketVerse
          </button>

          {/* Zone 2: Clean Typography Nav Links */}
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium">
            {navLinks.map((link) => (
              <button
                key={link.id}
                onClick={() => navigate(link.id)}
                className={`whitespace-nowrap shrink-0 transition-colors py-1 border-b-2 cursor-pointer ${
                  activeTab === link.id
                    ? 'text-amber-400 border-amber-400'
                    : 'text-slate-300 border-transparent hover:text-white'
                }`}
              >
                {link.label}
              </button>
            ))}
          </nav>

          {/* Zone 3: Friends, Profile, Primary Action + Logout */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              onClick={() => navigate('friends')}
              className={`hidden sm:inline-flex px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'friends'
                  ? 'text-amber-400 bg-slate-900 border border-amber-500/40'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Friends
            </button>

            <button
              onClick={() => navigate('profile')}
              className={`hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'profile'
                  ? 'text-amber-400 bg-slate-900 border border-amber-500/40'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              {dbUser?.profile?.avatarUrl ? (
                <img
                  src={dbUser.profile.avatarUrl}
                  alt={dbUser.profile.displayName}
                  referrerPolicy="no-referrer"
                  className="w-4 h-4 rounded-full object-cover"
                />
              ) : (
                <UserCircle2 className="w-4 h-4 text-amber-400" />
              )}
              <span className="font-mono-num">
                {dbUser?.profile?.uniquePlayerId || 'Profile'}
              </span>
            </button>

            <button
              onClick={() => navigate('matches')}
              className="hidden sm:inline-flex px-3.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
            >
              Match Center
            </button>

            <button
              onClick={logout}
              title={`Sign out (${dbUser?.profile?.uniquePlayerId || ''})`}
              className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>

            <button
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="md:hidden p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300"
              aria-label="Toggle Menu"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Mobile Drawer */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-slate-800 bg-[#0A1122] px-4 py-3 grid grid-cols-2 gap-2">
            {[
              ...navLinks,
              { id: 'friends' as NavTab, label: 'Friends' },
              { id: 'profile' as NavTab, label: 'My Profile' },
              { id: 'matches' as NavTab, label: 'Match Center' },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => navigate(item.id)}
                className={`py-2.5 px-3 rounded-lg text-xs font-semibold text-left ${
                  activeTab === item.id
                    ? 'bg-amber-500 text-slate-950'
                    : 'bg-[#060B18] text-slate-200 border border-slate-800'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {activeTab === 'dashboard' && <DashboardView onNavigate={navigate} />}
        {activeTab === 'profile' && <ProfileView onNavigate={navigate} />}
        {activeTab === 'leagues' && (
          <LeaguesView
            selectedLeagueId={selectedLeagueId}
            onSelectLeague={setSelectedLeagueId}
            onEnterAuction={(lid) => navigate('auction', lid)}
            initialInviteCode={pendingInviteCode}
            onConsumeInviteCode={clearPendingInviteCode}
          />
        )}
        {activeTab === 'auction' && (
          <AuctionRoomView
            leagueId={selectedLeagueId}
            onSelectLeague={setSelectedLeagueId}
            onOpenTeam={(lid) => navigate('team', lid)}
          />
        )}
        {activeTab === 'team' && <TeamManagerView leagueId={selectedLeagueId} />}
        {activeTab === 'friends' && <FriendsView />}
        {activeTab === 'players' && <PlayersDatabaseView />}
        {activeTab === 'matches' && <MatchCenterView />}
      </main>
    </div>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ProtectedRoute>
          <AppShell />
        </ProtectedRoute>
      </AuthProvider>
    </ErrorBoundary>
  );
}
