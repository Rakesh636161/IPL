import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  Save,
  Shield,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import {
  LeagueSummary,
  PlayingXiValidationResult,
  RosterEntry,
  SquadRoleCounts,
  SquadValidationResult,
  TeamDetailsResponse,
  TeamRecord,
  formatCurrency,
} from '../types/cricketverse.ts';
import {
  PLAYING_ROLE_LABELS,
  validatePlayingXiSelection,
} from '../lib/cricketEngine.ts';
import { syncPlayingXiFirestore } from '../services/playerFirestoreService.ts';
import { PlayerImage } from './PlayerImage.tsx';

interface TeamManagerViewProps {
  leagueId?: string | null;
}

const FALLBACK_TEAM_LOGO = '/src/assets/images/auction_gavel_gold_1794578451590.jpg';

export const TeamManagerView: React.FC<TeamManagerViewProps> = ({ leagueId }) => {
  const { apiFetch, firebaseUser } = useAuth();
  const [myTeams, setMyTeams] = useState<TeamRecord[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [team, setTeam] = useState<TeamRecord | null>(null);
  const [league, setLeague] = useState<LeagueSummary | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [roleCounts, setRoleCounts] = useState<SquadRoleCounts>({
    total: 0,
    batsmen: 0,
    bowlers: 0,
    allRounders: 0,
    wicketkeepers: 0,
    overseas: 0,
    domestic: 0,
  });
  const [squadValidation, setSquadValidation] = useState<SquadValidationResult | null>(null);
  const [serverXiValidation, setServerXiValidation] = useState<PlayingXiValidationResult | null>(null);

  const [teamName, setTeamName] = useState('');
  const [shortName, setShortName] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#D4AF37');
  const [captainId, setCaptainId] = useState<string>('');
  const [viceCaptainId, setViceCaptainId] = useState<string>('');
  const [keeperId, setKeeperId] = useState<string>('');
  const [playingXiIds, setPlayingXiIds] = useState<string[]>([]);
  const [bowlingOrderIds, setBowlingOrderIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [completingSquad, setCompletingSquad] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hydrateTeamDetails = useCallback((res: TeamDetailsResponse) => {
    setTeam(res.team);
    setLeague(res.league);
    setRoster(res.roster || []);
    setRoleCounts(res.roleCounts);
    setSquadValidation(res.squadValidation);
    setServerXiValidation(res.playingXiValidation);
    setTeamName(res.team.name);
    setShortName(res.team.shortName);
    setPrimaryColor(res.team.primaryColor);
    setCaptainId(res.team.captainPlayerId || '');
    setViceCaptainId(res.team.viceCaptainPlayerId || '');
    setKeeperId(res.team.wicketkeeperPlayerId || '');

    const xi = (res.roster || [])
      .filter((r) => r.isPlayingXi)
      .sort((a, b) => (a.battingOrder ?? 99) - (b.battingOrder ?? 99))
      .map((r) => r.player.id);
    setPlayingXiIds(xi.length > 0 ? xi : (res.roster || []).slice(0, 11).map((r) => r.player.id));

    const bowlers = (res.roster || [])
      .filter((r) => r.bowlingOrder !== null)
      .sort((a, b) => (a.bowlingOrder ?? 99) - (b.bowlingOrder ?? 99))
      .map((r) => r.player.id);
    setBowlingOrderIds(bowlers);
  }, []);

  useEffect(() => {
    apiFetch<{ teams: TeamRecord[] }>('/api/teams/mine').then((res) => {
      const list = res.teams || [];
      setMyTeams(list);
      if (leagueId) {
        const match = list.find((t) => t.leagueId === leagueId);
        if (match) {
          setSelectedTeamId(match.id);
          return;
        }
      }
      if (list.length > 0 && !selectedTeamId) {
        setSelectedTeamId(list[0].id);
      }
    });
  }, [leagueId]);

  const fetchSelectedTeam = useCallback(async () => {
    if (!selectedTeamId) return;
    const res = await apiFetch<TeamDetailsResponse>(`/api/teams/${selectedTeamId}`);
    hydrateTeamDetails(res);
  }, [apiFetch, selectedTeamId, hydrateTeamDetails]);

  useEffect(() => {
    fetchSelectedTeam().catch(() => {});
  }, [fetchSelectedTeam]);

  const substituteIds = useMemo(
    () => roster.filter((r) => !playingXiIds.includes(r.player.id)).map((r) => r.player.id),
    [roster, playingXiIds]
  );

  const liveXiValidation = useMemo(() => {
    if (roster.length === 0) return serverXiValidation;
    return validatePlayingXiSelection({
      ownedPlayerIds: roster.map((r) => r.player.id),
      playingXiIds,
      substituteIds,
      captainPlayerId: captainId || null,
      viceCaptainPlayerId: viceCaptainId || null,
      wicketkeeperPlayerId: keeperId || null,
      bowlingOrderIds,
    });
  }, [roster, playingXiIds, substituteIds, captainId, viceCaptainId, keeperId, bowlingOrderIds, serverXiValidation]);

  const toggleXi = (playerId: string) => {
    setMessage(null);
    setError(null);
    if (playingXiIds.includes(playerId)) {
      setPlayingXiIds(playingXiIds.filter((id) => id !== playerId));
      setBowlingOrderIds(bowlingOrderIds.filter((id) => id !== playerId));
    } else {
      if (playingXiIds.length >= 11) {
        setError('Playing XI cannot exceed 11 players. Move a player to Substitutes first.');
        return;
      }
      setPlayingXiIds([...playingXiIds, playerId]);
    }
  };

  const moveBattingOrder = (playerId: string, dir: -1 | 1) => {
    const idx = playingXiIds.indexOf(playerId);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= playingXiIds.length) return;
    const copy = [...playingXiIds];
    [copy[idx], copy[target]] = [copy[target], copy[idx]];
    setPlayingXiIds(copy);
  };

  const toggleBowlingSpot = (playerId: string) => {
    if (!playingXiIds.includes(playerId)) return;
    if (bowlingOrderIds.includes(playerId)) {
      setBowlingOrderIds(bowlingOrderIds.filter((id) => id !== playerId));
    } else {
      setBowlingOrderIds([...bowlingOrderIds, playerId]);
    }
  };

  const handleSave = async () => {
    if (!selectedTeamId || !team) return;
    if (captainId && viceCaptainId && captainId === viceCaptainId) {
      setError('Captain and Vice-Captain cannot be the same player.');
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await apiFetch<TeamDetailsResponse>(`/api/teams/${selectedTeamId}/lineup`, {
        method: 'PUT',
        body: JSON.stringify({
          teamName,
          shortName,
          primaryColor,
          captainPlayerId: captainId || null,
          viceCaptainPlayerId: viceCaptainId || null,
          wicketkeeperPlayerId: keeperId || null,
          playingXiIds,
          bowlingOrderIds,
          substituteIds,
        }),
      });
      hydrateTeamDetails(updated);

      if (firebaseUser?.uid && league) {
        await syncPlayingXiFirestore({
          leagueId: team.leagueId,
          leagueOwnerId: league.ownerUid || league.ownerId,
          teamId: team.id,
          ownerUid: firebaseUser.uid,
          captainPlayerId: captainId || null,
          viceCaptainPlayerId: viceCaptainId || null,
          wicketkeeperPlayerId: keeperId || null,
          playingXiIds,
          bowlingOrderIds,
          substituteIds,
          isValidForMatch: updated.playingXiValidation.isValid,
          roleCounts: updated.roleCounts,
          isSquadComplete: updated.team.isSquadComplete,
        }).catch(() => {});
      }

      setMessage('Franchise branding, Playing XI, and Substitutes saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save squad');
    } finally {
      setSaving(false);
    }
  };

  const handleMarkSquadComplete = async () => {
    if (!selectedTeamId || !team) return;
    setCompletingSquad(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await apiFetch<TeamDetailsResponse>(`/api/teams/${selectedTeamId}/complete`, {
        method: 'POST',
      });
      hydrateTeamDetails(updated);
      if (firebaseUser?.uid && league) {
        await syncPlayingXiFirestore({
          leagueId: team.leagueId,
          leagueOwnerId: league.ownerUid || league.ownerId,
          teamId: team.id,
          ownerUid: firebaseUser.uid,
          captainPlayerId: updated.team.captainPlayerId ?? null,
          viceCaptainPlayerId: updated.team.viceCaptainPlayerId ?? null,
          wicketkeeperPlayerId: updated.team.wicketkeeperPlayerId ?? null,
          playingXiIds,
          bowlingOrderIds,
          substituteIds,
          isValidForMatch: updated.playingXiValidation.isValid,
          roleCounts: updated.roleCounts,
          isSquadComplete: true,
        }).catch(() => {});
      }
      setMessage('Squad passed all league rules and is marked complete!');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Squad does not yet meet league rules.');
    } finally {
      setCompletingSquad(false);
    }
  };

  if (myTeams.length === 0) {
    return (
      <div className="p-8 rounded-xl bg-[#0B1325] border border-slate-800 text-center space-y-2">
        <Shield className="w-8 h-8 text-amber-400 mx-auto" />
        <h2 className="text-lg font-display font-bold text-white">No Franchises Owned Yet</h2>
        <p className="text-sm text-slate-400">
          Create or join a league and sign players in the auction room to build your squad.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header & Franchise Selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Franchise &amp; Playing XI Manager</h1>
          <p className="text-sm text-slate-400">
            Manage squad composition, league rule validation, leadership, Playing XI, and substitutes.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selectedTeamId}
            onChange={(e) => setSelectedTeamId(e.target.value)}
            className="px-3 py-2 rounded-lg bg-[#0B1325] border border-slate-700 text-sm text-white"
          >
            {myTeams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.shortName}){t.leagueName ? ` · ${t.leagueName}` : ''}
              </option>
            ))}
          </select>

          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{saving ? 'Saving...' : 'Save Lineup'}</span>
          </button>
        </div>
      </div>

      {error && <div className="p-3 rounded-lg bg-red-950/60 border border-red-800 text-xs text-red-200">{error}</div>}
      {message && (
        <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-700 text-xs text-emerald-200 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{message}</span>
        </div>
      )}

      {team && (
        <>
          {/* Franchise Identity & Purse Banner */}
          <div className="p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
            <div className="flex items-center gap-4">
              <img
                src={team.logoUrl || FALLBACK_TEAM_LOGO}
                alt={team.name}
                referrerPolicy="no-referrer"
                className="w-16 h-16 rounded-xl object-cover border-2 shrink-0"
                style={{ borderColor: primaryColor }}
              />
              <div className="space-y-1">
                <div className="text-xs text-amber-400 font-medium flex flex-wrap items-center gap-2">
                  <span>{league?.name || 'Franchise League'}</span>
                  <span>·</span>
                  <span>
                    Owner: {team.ownerName || 'Owner'} ({team.ownerPlayerId || 'CV'})
                  </span>
                  {team.isSquadComplete && (
                    <>
                      <span>·</span>
                      <span className="text-emerald-400 font-semibold">Squad Complete</span>
                    </>
                  )}
                </div>
                <h2 className="text-xl font-display font-bold text-white">
                  {team.name} <span className="font-mono-num text-slate-400 text-sm">({team.shortName})</span>
                </h2>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 font-mono-num">
              <div className="p-3 rounded-lg bg-[#060B18] border border-slate-800">
                <div className="text-[11px] font-sans text-slate-400">Total Purse</div>
                <div className="text-lg font-bold text-white">{formatCurrency(team.totalPurse)}</div>
              </div>
              <div className="p-3 rounded-lg bg-[#060B18] border border-slate-800">
                <div className="text-[11px] font-sans text-slate-400">Remaining Purse</div>
                <div className="text-lg font-bold text-emerald-400">{formatCurrency(team.remainingPurse)}</div>
              </div>
              <div className="p-3 rounded-lg bg-[#060B18] border border-slate-800">
                <div className="text-[11px] font-sans text-slate-400">Purchased Players</div>
                <div className="text-lg font-bold text-white">{roleCounts.total}</div>
              </div>
              <div className="p-3 rounded-lg bg-[#060B18] border border-slate-800">
                <div className="text-[11px] font-sans text-slate-400">Playing XI</div>
                <div className="text-lg font-bold text-amber-400">{playingXiIds.length} / 11</div>
              </div>
            </div>
          </div>

          {/* Role Composition Breakdown */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 font-mono-num">
            <div className="p-3.5 rounded-xl bg-[#0B1325] border border-slate-800/80">
              <div className="text-[11px] font-sans text-slate-400">Batsmen</div>
              <div className="text-xl font-bold text-white">{roleCounts.batsmen}</div>
            </div>
            <div className="p-3.5 rounded-xl bg-[#0B1325] border border-slate-800/80">
              <div className="text-[11px] font-sans text-slate-400">Bowlers</div>
              <div className="text-xl font-bold text-white">{roleCounts.bowlers}</div>
            </div>
            <div className="p-3.5 rounded-xl bg-[#0B1325] border border-slate-800/80">
              <div className="text-[11px] font-sans text-slate-400">All-Rounders</div>
              <div className="text-xl font-bold text-white">{roleCounts.allRounders}</div>
            </div>
            <div className="p-3.5 rounded-xl bg-[#0B1325] border border-slate-800/80">
              <div className="text-[11px] font-sans text-slate-400">Wicketkeepers</div>
              <div className="text-xl font-bold text-white">{roleCounts.wicketkeepers}</div>
            </div>
            <div className="p-3.5 rounded-xl bg-[#0B1325] border border-slate-800/80">
              <div className="text-[11px] font-sans text-slate-400">Overseas</div>
              <div className="text-xl font-bold text-amber-400">{roleCounts.overseas}</div>
            </div>
          </div>

          {/* Squad Rules Validation Panel */}
          {squadValidation && (
            <div className="p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-display font-semibold text-white flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-amber-400" />
                    <span>League Squad Rules Validation</span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    Squad rules do not restrict bidding during live auctions, but must pass before marking your squad complete.
                  </p>
                </div>

                <button
                  onClick={handleMarkSquadComplete}
                  disabled={completingSquad || team.isSquadComplete}
                  className={`px-4 py-2 rounded-lg text-xs font-bold whitespace-nowrap cursor-pointer ${
                    team.isSquadComplete
                      ? 'bg-emerald-950/60 border border-emerald-700 text-emerald-300'
                      : squadValidation.isValid
                      ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {team.isSquadComplete
                    ? 'Squad Validated & Complete'
                    : completingSquad
                    ? 'Validating...'
                    : 'Validate & Mark Squad Complete'}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
                {squadValidation.checks.map((chk) => (
                  <div
                    key={chk.key}
                    className={`p-3 rounded-lg border ${
                      chk.passed
                        ? 'bg-emerald-950/25 border-emerald-800/60'
                        : 'bg-[#060B18] border-amber-800/50'
                    }`}
                  >
                    <div className="flex items-center justify-between font-semibold">
                      <span className="text-slate-200">{chk.label}</span>
                      <span className={`font-mono-num ${chk.passed ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {chk.actual} ({chk.required})
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1">{chk.message}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Branding & Leadership Selectors */}
          <div className="p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Franchise Name</label>
              <input
                type="text"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Short Code &amp; Color</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  maxLength={4}
                  value={shortName}
                  onChange={(e) => setShortName(e.target.value.toUpperCase())}
                  className="flex-1 px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num uppercase"
                />
                <input
                  type="color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="w-10 h-9 rounded bg-[#060B18] border border-slate-700 cursor-pointer"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Captain (C)</label>
              <select
                value={captainId}
                onChange={(e) => setCaptainId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-xs text-white"
              >
                <option value="">Unassigned</option>
                {roster.map((r) => (
                  <option key={r.player.id} value={r.player.id}>
                    {r.player.name} ({r.player.overallRating})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Vice-Captain (VC)</label>
              <select
                value={viceCaptainId}
                onChange={(e) => setViceCaptainId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-xs text-white"
              >
                <option value="">Unassigned</option>
                {roster.map((r) => (
                  <option key={r.player.id} value={r.player.id}>
                    {r.player.name} ({r.player.overallRating})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Wicketkeeper (WK)</label>
              <select
                value={keeperId}
                onChange={(e) => setKeeperId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-xs text-white"
              >
                <option value="">Unassigned</option>
                {roster.map((r) => (
                  <option key={r.player.id} value={r.player.id}>
                    {r.player.name} ({PLAYING_ROLE_LABELS[r.player.role] || r.player.role})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Match Readiness / Playing XI Validation Banner */}
          {liveXiValidation && (
            <div
              className={`p-4 rounded-xl border text-xs space-y-1.5 ${
                liveXiValidation.isValid
                  ? 'bg-emerald-950/30 border-emerald-800/70 text-emerald-200'
                  : 'bg-amber-950/30 border-amber-800/70 text-amber-200'
              }`}
            >
              <div className="font-semibold flex items-center gap-2">
                {liveXiValidation.isValid ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>Playing XI Ready for Match Start (11/11 selected, C/VC/WK assigned)</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                    <span>Playing XI Requirements Before Match Start</span>
                  </>
                )}
              </div>
              {liveXiValidation.errors.length > 0 && (
                <ul className="list-disc list-inside text-amber-300 space-y-0.5">
                  {liveXiValidation.errors.map((errText) => (
                    <li key={errText}>{errText}</li>
                  ))}
                </ul>
              )}
              {liveXiValidation.warnings.length > 0 && (
                <ul className="list-disc list-inside text-slate-300 space-y-0.5">
                  {liveXiValidation.warnings.map((warnText) => (
                    <li key={warnText}>{warnText}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Squad Roster + Batting Order + Substitutes */}
          {roster.length === 0 ? (
            <div className="p-8 rounded-xl bg-[#0B1325] border border-slate-800/80 text-sm text-slate-400">
              No players purchased for this franchise yet. Enter the auction room to sign players.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Full Purchased Squad */}
              <div className="lg:col-span-7 p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-3">
                <h2 className="text-sm font-display font-semibold text-white">
                  Full Purchased Squad ({roster.length})
                </h2>
                <div className="divide-y divide-slate-800/70">
                  {roster.map((entry) => {
                    const inXi = playingXiIds.includes(entry.player.id);
                    const isBowler = bowlingOrderIds.includes(entry.player.id);
                    return (
                      <div key={entry.teamPlayerId} className="py-3 flex items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-3 min-w-0">
                          <PlayerImage
                            src={entry.player.imageUrl}
                            alt={entry.player.name}
                            className="w-10 h-10 rounded-lg object-cover object-top border border-slate-700 shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="font-semibold text-white truncate">
                              {entry.player.name}
                              {captainId === entry.player.id && ' (C)'}
                              {viceCaptainId === entry.player.id && ' (VC)'}
                              {keeperId === entry.player.id && ' (WK)'}
                            </div>
                            <div className="text-slate-400 font-mono-num">
                              {PLAYING_ROLE_LABELS[entry.player.role] || entry.player.role} · OVR{' '}
                              {entry.player.overallRating} · {entry.player.isOverseas ? 'OS' : 'DOM'} · Bought{' '}
                              {formatCurrency(entry.purchasePrice)}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {inXi && (
                            <button
                              onClick={() => toggleBowlingSpot(entry.player.id)}
                              className={`px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer ${
                                isBowler
                                  ? 'bg-sky-600/30 border border-sky-500/60 text-sky-300'
                                  : 'bg-[#060B18] border border-slate-700 text-slate-400'
                              }`}
                            >
                              {isBowler ? `Bowl #${bowlingOrderIds.indexOf(entry.player.id) + 1}` : '+ Bowl'}
                            </button>
                          )}

                          <button
                            onClick={() => toggleXi(entry.player.id)}
                            className={`px-3 py-1.5 rounded-md font-semibold flex items-center gap-1 cursor-pointer ${
                              inXi
                                ? 'bg-emerald-600 text-white'
                                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                            }`}
                          >
                            {inXi && <Check className="w-3.5 h-3.5" />}
                            <span>{inXi ? 'Playing XI' : 'Substitute'}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Batting Order & Substitutes Column */}
              <div className="lg:col-span-5 space-y-6">
                {/* Batting Order (1-11) */}
                <div className="p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-3">
                  <h2 className="text-sm font-display font-semibold text-white">
                    Playing XI Batting Order ({playingXiIds.length}/11)
                  </h2>
                  {playingXiIds.length === 0 ? (
                    <p className="text-xs text-slate-400">Select players from your squad to build the Playing XI.</p>
                  ) : (
                    <ol className="space-y-2">
                      {playingXiIds.map((pid, idx) => {
                        const entry = roster.find((r) => r.player.id === pid);
                        if (!entry) return null;
                        return (
                          <li
                            key={pid}
                            className="p-2.5 rounded-lg bg-[#060B18] border border-slate-800 flex items-center justify-between text-xs"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <span className="font-mono-num text-amber-400 font-bold w-5 shrink-0">{idx + 1}.</span>
                              <div className="min-w-0">
                                <div className="font-semibold text-white truncate">
                                  {entry.player.name}
                                  {captainId === pid && ' (C)'}
                                  {viceCaptainId === pid && ' (VC)'}
                                  {keeperId === pid && ' (WK)'}
                                </div>
                                <div className="text-[11px] text-slate-400 font-mono-num">
                                  {PLAYING_ROLE_LABELS[entry.player.role] || entry.player.role} · OVR{' '}
                                  {entry.player.overallRating}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => moveBattingOrder(pid, -1)}
                                disabled={idx === 0}
                                className="p-1 rounded bg-slate-800 disabled:opacity-30 text-slate-300 cursor-pointer"
                              >
                                <ArrowUp className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => moveBattingOrder(pid, 1)}
                                disabled={idx === playingXiIds.length - 1}
                                className="p-1 rounded bg-slate-800 disabled:opacity-30 text-slate-300 cursor-pointer"
                              >
                                <ArrowDown className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>

                {/* Substitutes Bench */}
                <div className="p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-3">
                  <h2 className="text-sm font-display font-semibold text-white flex items-center gap-2">
                    <Users className="w-4 h-4 text-slate-400" />
                    <span>Substitutes Bench ({substituteIds.length})</span>
                  </h2>
                  {substituteIds.length === 0 ? (
                    <p className="text-xs text-slate-500">All signed players are currently in your Playing XI.</p>
                  ) : (
                    <div className="space-y-2">
                      {substituteIds.map((sid) => {
                        const entry = roster.find((r) => r.player.id === sid);
                        if (!entry) return null;
                        return (
                          <div
                            key={sid}
                            className="p-2.5 rounded-lg bg-[#060B18] border border-slate-800 flex items-center justify-between text-xs"
                          >
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-200 truncate">{entry.player.name}</div>
                              <div className="text-[11px] text-slate-400 font-mono-num">
                                {PLAYING_ROLE_LABELS[entry.player.role] || entry.player.role} · OVR{' '}
                                {entry.player.overallRating} · {entry.ownershipStatus}
                              </div>
                            </div>
                            <button
                              onClick={() => toggleXi(sid)}
                              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-emerald-600 text-slate-200 hover:text-white text-[11px] font-semibold cursor-pointer shrink-0"
                            >
                              + Move to XI
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
