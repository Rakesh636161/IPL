import React, { useEffect, useState } from 'react';
import { Swords, Trophy } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { LeagueSummary, TeamRecord } from '../types/cricketverse.ts';

interface StandingRow {
  standing: {
    id: string;
    played: number;
    won: number;
    lost: number;
    tied: number;
    points: number;
    netRunRateScaled: number;
  };
  teamName: string;
  shortName: string;
  primaryColor: string;
}

interface MatchSummary {
  id: string;
  mode: string;
  summaryText: string | null;
  createdAt: string;
}

export const MatchCenterView: React.FC = () => {
  const { apiFetch } = useAuth();
  const [leagues, setLeagues] = useState<LeagueSummary[]>([]);
  const [selectedLeagueId, setSelectedLeagueId] = useState<string>('');
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [homeTeamId, setHomeTeamId] = useState('');
  const [awayTeamId, setAwayTeamId] = useState('');
  const [mode, setMode] = useState<'AI' | '1V1' | 'TOURNAMENT'>('TOURNAMENT');
  const [requireValidXi, setRequireValidXi] = useState(true);
  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [simulating, setSimulating] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ myLeagues: LeagueSummary[] }>('/api/leagues').then((res) => {
      const list = res.myLeagues || [];
      setLeagues(list);
      if (list.length > 0) setSelectedLeagueId(list[0].id);
    });
  }, []);

  const loadLeagueData = async (lid: string) => {
    if (!lid) return;
    try {
      const [details, standingsRes] = await Promise.all([
        apiFetch<{ teams: TeamRecord[] }>(`/api/leagues/${lid}`),
        apiFetch<{ standings: StandingRow[]; matches: MatchSummary[] }>(`/api/leagues/${lid}/standings`),
      ]);
      const t = details.teams || [];
      setTeams(t);
      if (t.length >= 2) {
        setHomeTeamId(t[0].id);
        setAwayTeamId(t[1].id);
      }
      setStandings(standingsRes.standings || []);
      setMatches(standingsRes.matches || []);
    } catch {
      // handled gracefully
    }
  };

  useEffect(() => {
    loadLeagueData(selectedLeagueId);
  }, [selectedLeagueId]);

  const handleSimulate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSimulating(true);
    setError(null);
    setLastResult(null);
    try {
      const res = await apiFetch<{ match: { summaryText: string } }>('/api/matches/simulate', {
        method: 'POST',
        body: JSON.stringify({
          homeTeamId,
          awayTeamId,
          mode,
          leagueId: selectedLeagueId || undefined,
          requireValidXi,
        }),
      });
      setLastResult(res.match.summaryText);
      await loadLeagueData(selectedLeagueId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Match simulation failed');
    } finally {
      setSimulating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Match Center &amp; Standings</h1>
          <p className="text-sm text-slate-400">
            Play against AI, challenge rival franchises 1v1, and track tournament points based on drafted squads.
          </p>
        </div>

        {leagues.length > 0 && (
          <select
            value={selectedLeagueId}
            onChange={(e) => setSelectedLeagueId(e.target.value)}
            className="px-3 py-2 rounded-lg bg-[#0B1325] border border-slate-700 text-sm text-white"
          >
            {leagues.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form
          onSubmit={handleSimulate}
          className="lg:col-span-5 p-6 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-4"
        >
          <h2 className="text-base font-display font-semibold text-white flex items-center gap-2">
            <Swords className="w-4 h-4 text-amber-400" />
            <span>Launch Match</span>
          </h2>

          <div>
            <label className="block text-xs text-slate-400 mb-1">Match Format</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'AI' | '1V1' | 'TOURNAMENT')}
              className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
            >
              <option value="TOURNAMENT">League Tournament Fixture</option>
              <option value="1V1">1v1 Franchise Duel</option>
              <option value="AI">Play Against AI</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1">Home Franchise</label>
            <select
              value={homeTeamId}
              onChange={(e) => setHomeTeamId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.squadCount} players)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1">Away Franchise</label>
            <select
              value={awayTeamId}
              onChange={(e) => setAwayTeamId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.squadCount} players)
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={requireValidXi}
              onChange={(e) => setRequireValidXi(e.target.checked)}
              className="mt-0.5 rounded border-slate-600 bg-[#060B18]"
            />
            <span>Enforce validated Playing XI (11 players, Captain, Vice-Captain &amp; Wicketkeeper)</span>
          </label>

          {error && (
            <div className="p-3 rounded-lg bg-red-950/60 border border-red-800/80 text-xs text-red-200">
              {error}
            </div>
          )}
          {lastResult && (
            <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-700 text-xs text-emerald-200">
              Result: {lastResult}
            </div>
          )}

          <button
            type="submit"
            disabled={simulating || teams.length < 2}
            className="w-full py-2.5 px-4 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 text-xs font-bold cursor-pointer"
          >
            {simulating ? 'Simulating 20 Overs...' : teams.length < 2 ? 'Need 2+ Teams in League' : 'Play 20-Over Match'}
          </button>
        </form>

        <div className="lg:col-span-7 space-y-6">
          <div className="p-6 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-4">
            <h2 className="text-base font-display font-semibold text-white flex items-center gap-2">
              <Trophy className="w-4 h-4 text-amber-400" />
              <span>Tournament Points Table</span>
            </h2>
            {standings.length === 0 ? (
              <p className="text-xs text-slate-400">No league matches completed yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="py-2 pr-3">Franchise</th>
                      <th className="py-2 px-2 text-right">P</th>
                      <th className="py-2 px-2 text-right">W</th>
                      <th className="py-2 px-2 text-right">L</th>
                      <th className="py-2 pl-2 text-right">Pts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono-num">
                    {standings.map((row) => (
                      <tr key={row.standing.id}>
                        <td className="py-2.5 pr-3 font-sans font-semibold text-white">
                          {row.teamName} <span className="text-slate-500">({row.shortName})</span>
                        </td>
                        <td className="py-2.5 px-2 text-right">{row.standing.played}</td>
                        <td className="py-2.5 px-2 text-right text-emerald-400">{row.standing.won}</td>
                        <td className="py-2.5 px-2 text-right text-slate-400">{row.standing.lost}</td>
                        <td className="py-2.5 pl-2 text-right font-bold text-amber-400">{row.standing.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="p-6 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-3">
            <h3 className="text-sm font-display font-semibold text-white">Recent Match Results</h3>
            {matches.length === 0 ? (
              <p className="text-xs text-slate-400">Completed match scorecards appear here.</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {matches.map((m) => (
                  <li key={m.id} className="p-3 rounded-lg bg-[#060B18] border border-slate-800 flex justify-between gap-2">
                    <span className="text-slate-200">{m.summaryText}</span>
                    <span className="text-slate-500 font-mono-num shrink-0">{m.mode}</span>
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
