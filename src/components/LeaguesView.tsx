import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  Ban,
  Check,
  CheckCircle2,
  Copy,
  Crown,
  Edit3,
  Gavel,
  Globe,
  Link2,
  Lock,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import {
  FriendEntry,
  LeagueActivityRecord,
  LeagueInvitationRecord,
  LeagueMember,
  LeagueSettingsRecord,
  LeagueStatus,
  LeagueSummary,
  TeamRecord,
  formatCurrency,
} from '../types/cricketverse.ts';
import {
  customizeMyTeamFirestore,
  invitePlayerFirestore,
  joinLeagueTransactionFirestore,
  lookupInviteCodeFirestore,
  removeOrLeaveMemberFirestore,
  requestToJoinLeagueFirestore,
  respondInvitationFirestore,
  subscribeToLeagueActivityFirestore,
  subscribeToLeagueInvitationsFirestore,
  subscribeToLeagueLobbyDocsFirestore,
  subscribeToMyLeaguesFirestore,
  subscribeToPublicLeaguesFirestore,
  syncInviteCodeChangeFirestore,
  syncLeagueCreatedFirestore,
  toggleMemberReadyFirestore,
  transferOwnershipFirestore,
  updateLeagueSettingsFirestore,
  updateLeagueStatusFirestore,
} from '../services/leagueFirestoreService.ts';

interface LeaguesViewProps {
  selectedLeagueId: string | null;
  onSelectLeague: (leagueId: string | null) => void;
  onEnterAuction: (leagueId: string) => void;
  initialInviteCode?: string | null;
  onConsumeInviteCode?: () => void;
}

const PRESET_LOGOS = [
  { label: 'Stadium Night', url: '/src/assets/images/cricket_stadium_night_1794578450905.jpg' },
  { label: 'Golden Gavel', url: '/src/assets/images/auction_gavel_gold_1794578451590.jpg' },
  { label: 'Striker Crest', url: '/src/assets/images/player_batsman_portrait_1794578454251.jpg' },
  { label: 'Pace Crest', url: '/src/assets/images/player_bowler_portrait_1794578454903.jpg' },
  { label: 'Keeper Crest', url: '/src/assets/images/player_keeper_portrait_1794578452592.jpg' },
];

const TEAM_COLORS = [
  '#D4AF37',
  '#10B981',
  '#3B82F6',
  '#F59E0B',
  '#EF4444',
  '#8B5CF6',
  '#06B6D4',
  '#EC4899',
];

const PRE_AUCTION_SET = new Set(['CREATED', 'OPEN', 'FULL', 'READY', 'LOBBY']);

function normalizeStatusLabel(status: LeagueStatus): string {
  if (status === 'LOBBY') return 'OPEN';
  if (status === 'AUCTION_LIVE') return 'AUCTION IN PROGRESS';
  return status.replace(/_/g, ' ');
}

function statusTextColor(status: LeagueStatus): string {
  switch (status) {
    case 'OPEN':
    case 'CREATED':
    case 'LOBBY':
      return 'text-emerald-400';
    case 'FULL':
      return 'text-amber-400';
    case 'READY':
      return 'text-sky-400';
    case 'AUCTION_IN_PROGRESS':
    case 'AUCTION_LIVE':
      return 'text-amber-300';
    case 'COMPLETED':
      return 'text-slate-300';
    case 'CANCELLED':
      return 'text-red-400';
    default:
      return 'text-slate-400';
  }
}

function extractInviteCodeFromInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('invite=')) {
    try {
      const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://cv.app/${trimmed}`);
      const code = parsed.searchParams.get('invite');
      if (code) return code.trim().toUpperCase();
    } catch {
      const match = trimmed.match(/invite=([A-Za-z0-9-]+)/i);
      if (match?.[1]) return match[1].toUpperCase();
    }
  }
  return trimmed.toUpperCase();
}

function defaultTeamForUser(displayName?: string | null) {
  const first = (displayName || 'Royal').trim().split(/\s+/)[0] || 'Royal';
  const name = `${first} Strikers`.slice(0, 36);
  const short = (first.replace(/[^A-Za-z0-9]/g, '').slice(0, 3) || 'RST').toUpperCase();
  return { name, short };
}

export const LeaguesView: React.FC<LeaguesViewProps> = ({
  selectedLeagueId,
  onSelectLeague,
  onEnterAuction,
  initialInviteCode,
  onConsumeInviteCode,
}) => {
  const { dbUser, firebaseUser, apiFetch, getIdToken } = useAuth();

  const [myLeagues, setMyLeagues] = useState<LeagueSummary[]>([]);
  const [publicLeagues, setPublicLeagues] = useState<LeagueSummary[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<LeagueInvitationRecord[]>([]);
  const [recentActivity, setRecentActivity] = useState<LeagueActivityRecord[]>([]);
  const [friends, setFriends] = useState<FriendEntry[]>([]);

  const [lobbyDetails, setLobbyDetails] = useState<{
    league: LeagueSummary;
    settings: LeagueSettingsRecord | null;
    members: LeagueMember[];
    teams: TeamRecord[];
    invitations: LeagueInvitationRecord[];
    activity: LeagueActivityRecord[];
  } | null>(null);

  const [mode, setMode] = useState<'BROWSE' | 'CREATE' | 'JOIN'>('BROWSE');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [copiedFlag, setCopiedFlag] = useState<string | null>(null);

  // Create League Form State
  const [leagueName, setLeagueName] = useState('Premier Franchise Cup');
  const [leagueDescription, setLeagueDescription] = useState(
    'Competitive multiplayer franchise auction & tournament.'
  );
  const [leagueLogoUrl, setLeagueLogoUrl] = useState<string>(PRESET_LOGOS[0].url);
  const [visibility, setVisibility] = useState<'PRIVATE' | 'PUBLIC'>('PRIVATE');
  const [maxTeams, setMaxTeams] = useState(10);
  const [numberOfTeams, setNumberOfTeams] = useState(10);
  const [purseAmount, setPurseAmount] = useState(10000);
  const [minSquadSize, setMinSquadSize] = useState(15);
  const [maxSquadSize, setMaxSquadSize] = useState(25);
  const [maxOverseas, setMaxOverseas] = useState(8);
  const [minWicketkeepers, setMinWicketkeepers] = useState(1);
  const [minBatsmen, setMinBatsmen] = useState(4);
  const [minBowlers, setMinBowlers] = useState(4);
  const [minAllRounders, setMinAllRounders] = useState(2);
  const [bidIncrement, setBidIncrement] = useState(25);
  const [timerSeconds, setTimerSeconds] = useState(15);
  const [auctionMode, setAuctionMode] = useState<'MEGA' | 'MINI' | 'FAST_TRACK'>('MEGA');
  const [inviteExpiryHours, setInviteExpiryHours] = useState<number>(72);
  const [allowTeamCustomization, setAllowTeamCustomization] = useState(true);
  const [teamName, setTeamName] = useState('Royal Strikers');
  const [teamShortName, setTeamShortName] = useState('RST');
  const [teamLogoUrl, setTeamLogoUrl] = useState<string>(PRESET_LOGOS[2].url);

  // Join League Form State
  const [inviteCode, setInviteCode] = useState('');
  const [joinTeamName, setJoinTeamName] = useState('Titan Warriors');
  const [joinShortName, setJoinShortName] = useState('TTW');
  const [joinTeamLogoUrl, setJoinTeamLogoUrl] = useState<string>(PRESET_LOGOS[3].url);
  const [previewLeague, setPreviewLeague] = useState<{
    league: LeagueSummary;
    alreadyMember: boolean;
    isFull: boolean;
    joinable: boolean;
  } | null>(null);
  const [requestLeagueIdInput, setRequestLeagueIdInput] = useState('');

  // Invite Player by CV ID inside lobby
  const [invitePlayerIdInput, setInvitePlayerIdInput] = useState('');

  // Team customization inside lobby
  const [editingTeam, setEditingTeam] = useState(false);
  const [customTeamName, setCustomTeamName] = useState('');
  const [customShortName, setCustomShortName] = useState('');
  const [customColor, setCustomColor] = useState('#D4AF37');
  const [customTeamLogo, setCustomTeamLogo] = useState<string>(PRESET_LOGOS[2].url);

  // Owner Settings Edit inside lobby
  const [editingSettings, setEditingSettings] = useState(false);
  const [editSettingsForm, setEditSettingsForm] = useState({
    name: '',
    description: '',
    logoUrl: '',
    visibility: 'PRIVATE' as 'PRIVATE' | 'PUBLIC',
    maxTeams: 10,
    numberOfTeams: 10,
    purseAmount: 10000,
    minSquadSize: 15,
    maxSquadSize: 25,
    maxOverseas: 8,
    minWicketkeepers: 1,
    minBatsmen: 4,
    minBowlers: 4,
    minAllRounders: 2,
    bidIncrement: 25,
    timerSeconds: 15,
    auctionMode: 'MEGA' as 'MEGA' | 'MINI' | 'FAST_TRACK',
    allowTeamCustomization: true,
  });

  // Inline confirmation states (no window.confirm)
  const [confirmCancelLeague, setConfirmCancelLeague] = useState(false);
  const [confirmLeaveLeague, setConfirmLeaveLeague] = useState(false);
  const [confirmRemoveUid, setConfirmRemoveUid] = useState<string | null>(null);
  const [confirmTransferUid, setConfirmTransferUid] = useState<string | null>(null);

  // Public league quick-join modal inline
  const [quickJoinPublicId, setQuickJoinPublicId] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setError(null);
  };

  const copyText = (key: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedFlag(key);
    setTimeout(() => setCopiedFlag((prev) => (prev === key ? null : prev)), 1800);
  };

  const fetchLeagues = useCallback(async () => {
    try {
      const [leaguesRes, friendsRes] = await Promise.all([
        apiFetch<{
          myLeagues: LeagueSummary[];
          publicLeagues: LeagueSummary[];
          pendingInvitations?: LeagueInvitationRecord[];
          recentActivity?: LeagueActivityRecord[];
        }>('/api/leagues'),
        apiFetch<{ accepted: FriendEntry[] }>('/api/friends'),
      ]);
      setMyLeagues(leaguesRes.myLeagues || []);
      setPublicLeagues(leaguesRes.publicLeagues || []);
      setPendingInvitations(leaguesRes.pendingInvitations || []);
      setRecentActivity(leaguesRes.recentActivity || []);
      setFriends(friendsRes.accepted || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leagues');
    }
  }, [apiFetch]);

  const fetchLobby = useCallback(
    async (id: string) => {
      try {
        const res = await apiFetch<{
          league: LeagueSummary;
          settings: LeagueSettingsRecord | null;
          members: LeagueMember[];
          teams: TeamRecord[];
          invitations?: LeagueInvitationRecord[];
          activity?: LeagueActivityRecord[];
        }>(`/api/leagues/${id}`);
        setLobbyDetails({
          league: res.league,
          settings: res.settings ?? null,
          members: res.members || [],
          teams: res.teams || [],
          invitations: res.invitations || [],
          activity: res.activity || [],
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load league lobby');
      }
    },
    [apiFetch]
  );

  // Initial team name defaults from user profile
  useEffect(() => {
    if (dbUser?.profile?.displayName) {
      const d = defaultTeamForUser(dbUser.profile.displayName);
      setTeamName(d.name);
      setTeamShortName(d.short);
      setJoinTeamName(d.name);
      setJoinShortName(d.short);
    }
  }, [dbUser?.profile?.displayName]);

  // Load initial data
  useEffect(() => {
    fetchLeagues();
  }, [fetchLeagues]);

  useEffect(() => {
    if (selectedLeagueId) {
      fetchLobby(selectedLeagueId);
      setConfirmCancelLeague(false);
      setConfirmLeaveLeague(false);
      setConfirmRemoveUid(null);
      setConfirmTransferUid(null);
      setEditingSettings(false);
      setEditingTeam(false);
    } else {
      setLobbyDetails(null);
    }
  }, [selectedLeagueId, fetchLobby]);

  // Handle ?invite=CV-XXXXXX deep link on load
  const handlePreviewInviteCode = useCallback(
    async (rawCode: string) => {
      const clean = extractInviteCodeFromInput(rawCode);
      setInviteCode(clean);
      setPreviewLeague(null);
      if (clean.length < 4) return;
      setError(null);
      try {
        // Attempt Firestore exact code lookup for fast check, then authoritative preview
        await lookupInviteCodeFirestore(clean).catch(() => null);
        const preview = await apiFetch<{
          league: LeagueSummary;
          alreadyMember: boolean;
          isFull: boolean;
          joinable: boolean;
        }>(`/api/leagues/validate-code?code=${encodeURIComponent(clean)}`);
        setPreviewLeague(preview);
      } catch (err) {
        setPreviewLeague(null);
        setError(err instanceof Error ? err.message : 'Invalid invitation code.');
      }
    },
    [apiFetch]
  );

  useEffect(() => {
    if (initialInviteCode) {
      setMode('JOIN');
      handlePreviewInviteCode(initialInviteCode);
      onConsumeInviteCode?.();
    }
  }, [initialInviteCode, handlePreviewInviteCode, onConsumeInviteCode]);

  // Real-time Firestore onSnapshot listeners
  useEffect(() => {
    const uid = firebaseUser?.uid;
    if (!uid) return;

    const unsubMy = subscribeToMyLeaguesFirestore(uid, () => {
      fetchLeagues();
    });
    const unsubPublic = subscribeToPublicLeaguesFirestore(() => {
      fetchLeagues();
    });
    const unsubInv = subscribeToLeagueInvitationsFirestore(uid, () => {
      fetchLeagues();
      if (selectedLeagueId) fetchLobby(selectedLeagueId);
    });
    const unsubAct = subscribeToLeagueActivityFirestore(uid, () => {
      fetchLeagues();
      if (selectedLeagueId) fetchLobby(selectedLeagueId);
    });

    return () => {
      unsubMy();
      unsubPublic();
      unsubInv();
      unsubAct();
    };
  }, [firebaseUser?.uid, selectedLeagueId, fetchLeagues, fetchLobby]);

  // Real-time Firestore listener for selected lobby doc
  useEffect(() => {
    if (!selectedLeagueId || !firebaseUser?.uid) return;
    return subscribeToLeagueLobbyDocsFirestore(selectedLeagueId, () => {
      fetchLobby(selectedLeagueId);
      fetchLeagues();
    });
  }, [selectedLeagueId, firebaseUser?.uid, fetchLobby, fetchLeagues]);

  // Real-time Socket.IO room subscription for selected league lobby
  useEffect(() => {
    if (!selectedLeagueId) return;
    let active = true;

    const connectLobbySocket = async () => {
      const token = await getIdToken();
      if (!token || !active) return;

      const socket = io({
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        if (!active) return;
        socket.emit('league:join', { leagueId: selectedLeagueId });
      });

      socket.on('league:updated', () => {
        if (!active) return;
        fetchLobby(selectedLeagueId);
        fetchLeagues();
      });
    };

    connectLobbySocket();

    return () => {
      active = false;
      if (socketRef.current) {
        socketRef.current.emit('league:leave', { leagueId: selectedLeagueId });
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [selectedLeagueId, getIdToken, fetchLobby, fetchLeagues]);

  // Sync edit settings form when lobby loads
  useEffect(() => {
    if (lobbyDetails) {
      const l = lobbyDetails.league;
      const s = lobbyDetails.settings;
      setEditSettingsForm({
        name: l.name,
        description: l.description || '',
        logoUrl: l.logoUrl || '',
        visibility: l.visibility,
        maxTeams: l.maxTeams,
        numberOfTeams: l.numberOfTeams ?? l.maxTeams,
        purseAmount: l.purseAmount,
        minSquadSize: l.minSquadSize,
        maxSquadSize: l.maxSquadSize,
        maxOverseas: s?.maxOverseas ?? 8,
        minWicketkeepers: s?.minWicketkeepers ?? 1,
        minBatsmen: s?.minBatsmen ?? 4,
        minBowlers: s?.minBowlers ?? 4,
        minAllRounders: s?.minAllRounders ?? 2,
        bidIncrement: l.bidIncrement,
        timerSeconds: l.timerSeconds,
        auctionMode: l.auctionMode,
        allowTeamCustomization: s?.allowTeamCustomization ?? true,
      });
    }
  }, [lobbyDetails?.league.id, lobbyDetails?.league.updatedAt]);

  const handleCreateLeague = async (e: React.FormEvent) => {
    e.preventDefault();
    if (maxSquadSize < minSquadSize) {
      setError('Maximum players allowed must be greater than or equal to minimum players required.');
      return;
    }
    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiFetch<{
        league: LeagueSummary;
        settings: LeagueSettingsRecord;
        team: TeamRecord;
      }>('/api/leagues', {
        method: 'POST',
        body: JSON.stringify({
          name: leagueName,
          description: leagueDescription,
          logoUrl: leagueLogoUrl || null,
          visibility,
          maxTeams,
          numberOfTeams,
          purseAmount,
          minSquadSize,
          maxSquadSize,
          bidIncrement,
          timerSeconds,
          auctionMode,
          teamName,
          teamShortName,
          teamLogoUrl: teamLogoUrl || null,
          inviteCodeExpiresInHours: inviteExpiryHours > 0 ? inviteExpiryHours : null,
          settings: {
            allowTeamCustomization,
            minBatsmen,
            minBowlers,
            minAllRounders,
            minWicketkeepers,
            maxOverseas,
          },
        }),
      });

      if (firebaseUser?.uid && dbUser?.profile) {
        await syncLeagueCreatedFirestore({
          leagueId: res.league.id,
          name: res.league.name,
          description: res.league.description,
          logoUrl: res.league.logoUrl,
          visibility: res.league.visibility,
          ownerUid: firebaseUser.uid,
          ownerName: dbUser.profile.displayName,
          ownerPlayerId: dbUser.profile.uniquePlayerId,
          ownerPhotoUrl: dbUser.profile.avatarUrl,
          inviteCode: res.league.inviteCode,
          inviteCodeExpiresAt: res.league.inviteCodeExpiresAt,
          maxParticipants: res.league.maxTeams,
          numberOfTeams: res.league.numberOfTeams ?? res.league.maxTeams,
          startingPurse: res.league.purseAmount,
          squadSize: res.league.maxSquadSize,
          minPlayers: res.league.minSquadSize,
          maxPlayers: res.league.maxSquadSize,
          bidIncrement: res.league.bidIncrement,
          timerDuration: res.league.timerSeconds,
          auctionMode: res.league.auctionMode,
          allowTeamCustomization,
          minBatsmen,
          minBowlers,
          minAllRounders,
          minWicketkeepers,
          maxOverseas,
          teamId: res.team.id,
          teamName: res.team.name,
          teamShortName: res.team.shortName,
          teamLogoUrl: res.team.logoUrl,
          primaryColor: res.team.primaryColor,
        }).catch(() => {});
      }

      await fetchLeagues();
      onSelectLeague(res.league.id);
      setMode('BROWSE');
      showSuccess(`League "${res.league.name}" created. Invite code: ${res.league.inviteCode}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create league');
    } finally {
      setBusy(false);
    }
  };

  const handleJoinByCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = extractInviteCodeFromInput(inviteCode);
    if (!cleanCode) {
      setError('Enter a valid invitation code or link.');
      return;
    }
    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiFetch<{ league: LeagueSummary; team: TeamRecord }>('/api/leagues/join', {
        method: 'POST',
        body: JSON.stringify({
          inviteCode: cleanCode,
          teamName: joinTeamName,
          teamShortName: joinShortName,
          teamLogoUrl: joinTeamLogoUrl || null,
        }),
      });

      if (firebaseUser?.uid && dbUser?.profile) {
        await joinLeagueTransactionFirestore({
          leagueId: res.league.id,
          userUid: firebaseUser.uid,
          username: dbUser.profile.displayName,
          uniquePlayerId: dbUser.profile.uniquePlayerId,
          photoUrl: dbUser.profile.avatarUrl,
          teamId: res.team.id,
          teamName: res.team.name,
          teamShortName: res.team.shortName,
          teamLogoUrl: res.team.logoUrl,
          primaryColor: res.team.primaryColor,
          joinedViaCode: cleanCode,
        }).catch(() => {});
      }

      await fetchLeagues();
      onSelectLeague(res.league.id);
      setMode('BROWSE');
      setPreviewLeague(null);
      showSuccess(`Successfully joined "${res.league.name}" as ${res.team.name} (${res.team.shortName}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join league');
    } finally {
      setBusy(false);
    }
  };

  const handleJoinPublicLeague = async (leagueId: string) => {
    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiFetch<{ league: LeagueSummary; team: TeamRecord }>(
        `/api/leagues/${leagueId}/join-public`,
        {
          method: 'POST',
          body: JSON.stringify({
            teamName: joinTeamName,
            teamShortName: joinShortName,
            teamLogoUrl: joinTeamLogoUrl || null,
          }),
        }
      );

      if (firebaseUser?.uid && dbUser?.profile) {
        await joinLeagueTransactionFirestore({
          leagueId: res.league.id,
          userUid: firebaseUser.uid,
          username: dbUser.profile.displayName,
          uniquePlayerId: dbUser.profile.uniquePlayerId,
          photoUrl: dbUser.profile.avatarUrl,
          teamId: res.team.id,
          teamName: res.team.name,
          teamShortName: res.team.shortName,
          teamLogoUrl: res.team.logoUrl,
          primaryColor: res.team.primaryColor,
        }).catch(() => {});
      }

      setQuickJoinPublicId(null);
      await fetchLeagues();
      onSelectLeague(res.league.id);
      showSuccess(`Joined public league "${res.league.name}" as ${res.team.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join public league');
    } finally {
      setBusy(false);
    }
  };

  const handleRequestJoinPrivate = async (leagueIdToReq: string) => {
    const cleanId = leagueIdToReq.trim();
    if (!cleanId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/leagues/${cleanId}/request-join`, { method: 'POST' });
      if (firebaseUser?.uid && dbUser?.profile) {
        await requestToJoinLeagueFirestore({
          leagueId: cleanId,
          requesterUid: firebaseUser.uid,
          requesterUsername: dbUser.profile.displayName,
          requesterPlayerId: dbUser.profile.uniquePlayerId,
        }).catch(() => {});
      }
      setRequestLeagueIdInput('');
      await fetchLeagues();
      showSuccess('Join request sent to the league owner for approval.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send join request');
    } finally {
      setBusy(false);
    }
  };

  const handleRespondInvitation = async (
    inv: LeagueInvitationRecord,
    action: 'ACCEPT' | 'REJECT' | 'REVOKE'
  ) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ league?: LeagueSummary; team?: TeamRecord }>(
        `/api/leagues/invitations/${inv.id}/respond`,
        {
          method: 'POST',
          body: JSON.stringify({
            action,
            ...(action === 'ACCEPT' && inv.type === 'DIRECT_INVITE'
              ? {
                  teamName: joinTeamName,
                  teamShortName: joinShortName,
                  teamLogoUrl: joinTeamLogoUrl || null,
                }
              : {}),
          }),
        }
      );

      const targetUid = inv.type === 'DIRECT_INVITE' ? inv.recipientUid : inv.senderUid;
      if (firebaseUser?.uid && targetUid) {
        const fsInvId = `${inv.leagueId}__${targetUid}`;
        await respondInvitationFirestore({
          invitationId: fsInvId,
          action,
          actorUid: firebaseUser.uid,
          teamId: res.team?.id,
          teamName: res.team?.name,
          teamShortName: res.team?.shortName,
          teamLogoUrl: res.team?.logoUrl,
          primaryColor: res.team?.primaryColor,
        }).catch(() => {});
      }

      await fetchLeagues();
      if (selectedLeagueId) await fetchLobby(selectedLeagueId);
      if (action === 'ACCEPT' && res.league) {
        onSelectLeague(res.league.id);
        showSuccess(
          inv.type === 'DIRECT_INVITE'
            ? `Accepted invitation and joined "${res.league.name}".`
            : `Approved ${inv.senderName}'s join request.`
        );
      } else {
        showSuccess(
          action === 'REJECT'
            ? 'Invitation declined.'
            : 'Invitation revoked and disabled.'
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process invitation');
    } finally {
      setBusy(false);
    }
  };

  const handleInviteByPlayerId = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLeagueId || !invitePlayerIdInput.trim()) return;
    const cleanPid = invitePlayerIdInput.trim().toUpperCase();
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/leagues/${selectedLeagueId}/invite`, {
        method: 'POST',
        body: JSON.stringify({ uniquePlayerId: cleanPid }),
      });

      if (firebaseUser?.uid && dbUser?.profile) {
        await invitePlayerFirestore({
          leagueId: selectedLeagueId,
          senderUid: firebaseUser.uid,
          senderUsername: dbUser.profile.displayName,
          senderPlayerId: dbUser.profile.uniquePlayerId,
          targetUniquePlayerId: cleanPid,
        }).catch(() => {});
      }

      setInvitePlayerIdInput('');
      await Promise.all([fetchLobby(selectedLeagueId), fetchLeagues()]);
      showSuccess(`Invitation sent to ${cleanPid}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send invitation');
    } finally {
      setBusy(false);
    }
  };

  const handleInviteFriend = async (friend: FriendEntry) => {
    if (!selectedLeagueId) return;
    setError(null);
    try {
      await apiFetch(`/api/leagues/${selectedLeagueId}/invite`, {
        method: 'POST',
        body: JSON.stringify({ targetUserId: friend.userId }),
      });

      if (firebaseUser?.uid && dbUser?.profile && friend.uniquePlayerId) {
        await invitePlayerFirestore({
          leagueId: selectedLeagueId,
          senderUid: firebaseUser.uid,
          senderUsername: dbUser.profile.displayName,
          senderPlayerId: dbUser.profile.uniquePlayerId,
          targetUniquePlayerId: friend.uniquePlayerId,
        }).catch(() => {});
      }

      await Promise.all([fetchLobby(selectedLeagueId), fetchLeagues()]);
      showSuccess(`Invited ${friend.displayName} (${friend.uniquePlayerId}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite friend');
    }
  };

  const handleToggleReady = async (currentReady: boolean) => {
    if (!selectedLeagueId) return;
    setError(null);
    try {
      await apiFetch(`/api/leagues/${selectedLeagueId}/ready`, {
        method: 'POST',
        body: JSON.stringify({ isReady: !currentReady }),
      });
      if (firebaseUser?.uid) {
        await toggleMemberReadyFirestore(selectedLeagueId, firebaseUser.uid, !currentReady).catch(() => {});
      }
      await fetchLobby(selectedLeagueId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle ready status');
    }
  };

  const handleSaveTeamCustomization = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLeagueId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/leagues/${selectedLeagueId}/team`, {
        method: 'PATCH',
        body: JSON.stringify({
          teamName: customTeamName,
          shortName: customShortName,
          primaryColor: customColor,
          logoUrl: customTeamLogo || null,
        }),
      });

      if (firebaseUser?.uid && dbUser?.profile) {
        await customizeMyTeamFirestore({
          leagueId: selectedLeagueId,
          userUid: firebaseUser.uid,
          actorName: dbUser.profile.displayName,
          teamName: customTeamName,
          shortName: customShortName,
          primaryColor: customColor,
          logoUrl: customTeamLogo || null,
        }).catch(() => {});
      }

      setEditingTeam(false);
      await fetchLobby(selectedLeagueId);
      showSuccess('Franchise branding updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to customize team');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLeagueId) return;
    if (editSettingsForm.maxSquadSize < editSettingsForm.minSquadSize) {
      setError('Max players allowed must be >= min players required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/leagues/${selectedLeagueId}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...editSettingsForm,
          logoUrl: editSettingsForm.logoUrl || null,
        }),
      });

      if (firebaseUser?.uid && dbUser?.profile) {
        await updateLeagueSettingsFirestore({
          leagueId: selectedLeagueId,
          actorUid: firebaseUser.uid,
          actorName: dbUser.profile.displayName,
          updates: {
            name: editSettingsForm.name,
            description: editSettingsForm.description,
            logoUrl: editSettingsForm.logoUrl || null,
            visibility: editSettingsForm.visibility,
            maxParticipants: editSettingsForm.maxTeams,
            numberOfTeams: editSettingsForm.numberOfTeams,
            startingPurse: editSettingsForm.purseAmount,
            squadSize: editSettingsForm.maxSquadSize,
            minPlayers: editSettingsForm.minSquadSize,
            maxPlayers: editSettingsForm.maxSquadSize,
            bidIncrement: editSettingsForm.bidIncrement,
            timerDuration: editSettingsForm.timerSeconds,
            auctionMode: editSettingsForm.auctionMode,
            allowTeamCustomization: editSettingsForm.allowTeamCustomization,
            minBatsmen: editSettingsForm.minBatsmen,
            minBowlers: editSettingsForm.minBowlers,
            minAllRounders: editSettingsForm.minAllRounders,
            minWicketkeepers: editSettingsForm.minWicketkeepers,
            maxOverseas: editSettingsForm.maxOverseas,
          },
        }).catch(() => {});
      }

      setEditingSettings(false);
      await Promise.all([fetchLobby(selectedLeagueId), fetchLeagues()]);
      showSuccess('League settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update league settings');
    } finally {
      setBusy(false);
    }
  };

  const handleRegenerateInviteCode = async () => {
    if (!selectedLeagueId || !lobbyDetails) return;
    const oldCode = lobbyDetails.league.inviteCode;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ league: LeagueSummary }>(
        `/api/leagues/${selectedLeagueId}/invite-code/regenerate`,
        {
          method: 'POST',
          body: JSON.stringify({ expiresInHours: 72 }),
        }
      );

      if (firebaseUser?.uid && dbUser?.profile) {
        await syncInviteCodeChangeFirestore({
          leagueId: selectedLeagueId,
          actorUid: firebaseUser.uid,
          actorName: dbUser.profile.displayName,
          oldCode,
          newCode: res.league.inviteCode,
          active: true,
          expiresAt: res.league.inviteCodeExpiresAt,
        }).catch(() => {});
      }

      await fetchLobby(selectedLeagueId);
      showSuccess(`New invitation code generated: ${res.league.inviteCode}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate invite code');
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeInviteCode = async () => {
    if (!selectedLeagueId || !lobbyDetails) return;
    const oldCode = lobbyDetails.league.inviteCode;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/leagues/${selectedLeagueId}/invite-code/revoke`, { method: 'POST' });

      if (firebaseUser?.uid && dbUser?.profile) {
        await syncInviteCodeChangeFirestore({
          leagueId: selectedLeagueId,
          actorUid: firebaseUser.uid,
          actorName: dbUser.profile.displayName,
          oldCode,
          newCode: oldCode,
          active: false,
          expiresAt: null,
        }).catch(() => {});
      }

      await fetchLobby(selectedLeagueId);
      showSuccess('Active invitation code revoked.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke invite code');
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveMember = async (member: LeagueMember) => {
    if (!selectedLeagueId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/leagues/${selectedLeagueId}/members/${member.userId}`, {
        method: 'DELETE',
      });

      if (firebaseUser?.uid && dbUser?.profile && member.uid) {
        await removeOrLeaveMemberFirestore({
          leagueId: selectedLeagueId,
          targetUid: member.uid,
          actorUid: firebaseUser.uid,
          actorName: dbUser.profile.displayName,
          isSelfLeave: false,
        }).catch(() => {});
      }

      setConfirmRemoveUid(null);
      await Promise.all([fetchLobby(selectedLeagueId), fetchLeagues()]);
      showSuccess(`Removed ${member.displayName || 'member'} from the league.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    } finally {
      setBusy(false);
    }
  };

  const handleLeaveLeague = async () => {
    if (!selectedLeagueId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/leagues/${selectedLeagueId}/leave`, { method: 'POST' });

      if (firebaseUser?.uid && dbUser?.profile) {
        await removeOrLeaveMemberFirestore({
          leagueId: selectedLeagueId,
          targetUid: firebaseUser.uid,
          actorUid: firebaseUser.uid,
          actorName: dbUser.profile.displayName,
          isSelfLeave: true,
        }).catch(() => {});
      }

      setConfirmLeaveLeague(false);
      onSelectLeague(null);
      await fetchLeagues();
      showSuccess('You have left the league.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to leave league');
    } finally {
      setBusy(false);
    }
  };

  const handleTransferOwnership = async (member: LeagueMember) => {
    if (!selectedLeagueId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/leagues/${selectedLeagueId}/transfer-ownership`, {
        method: 'POST',
        body: JSON.stringify({ newOwnerUserId: member.userId }),
      });

      if (firebaseUser?.uid && dbUser?.profile && member.uid) {
        await transferOwnershipFirestore({
          leagueId: selectedLeagueId,
          currentOwnerUid: firebaseUser.uid,
          currentOwnerName: dbUser.profile.displayName,
          newOwnerUid: member.uid,
          newOwnerName: member.displayName || 'New Owner',
          newOwnerPlayerId: member.uniquePlayerId || 'CV100001',
        }).catch(() => {});
      }

      setConfirmTransferUid(null);
      await Promise.all([fetchLobby(selectedLeagueId), fetchLeagues()]);
      showSuccess(`Transferred ownership to ${member.displayName || 'member'}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to transfer ownership');
    } finally {
      setBusy(false);
    }
  };

  const handleMarkLeagueReady = async (ready: boolean) => {
    if (!selectedLeagueId || !lobbyDetails) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ league: LeagueSummary }>(
        `/api/leagues/${selectedLeagueId}/league-ready`,
        {
          method: 'POST',
          body: JSON.stringify({ ready }),
        }
      );

      if (firebaseUser?.uid && dbUser?.profile) {
        const nextSt = res.league.status as 'OPEN' | 'FULL' | 'READY';
        await updateLeagueStatusFirestore({
          leagueId: selectedLeagueId,
          actorUid: firebaseUser.uid,
          actorName: dbUser.profile.displayName,
          nextStatus: nextSt,
          actionType: 'LEAGUE_READY',
          message: ready ? 'League marked READY for auction.' : 'League reopened in lobby.',
        }).catch(() => {});
      }

      await Promise.all([fetchLobby(selectedLeagueId), fetchLeagues()]);
      showSuccess(ready ? 'League marked READY.' : 'League returned to lobby status.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update league readiness');
    } finally {
      setBusy(false);
    }
  };

  const handleCancelLeague = async () => {
    if (!selectedLeagueId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/leagues/${selectedLeagueId}/cancel`, { method: 'POST' });

      if (firebaseUser?.uid && dbUser?.profile) {
        await updateLeagueStatusFirestore({
          leagueId: selectedLeagueId,
          actorUid: firebaseUser.uid,
          actorName: dbUser.profile.displayName,
          nextStatus: 'CANCELLED',
          actionType: 'LEAGUE_CANCELLED',
          message: 'League closed and cancelled by the owner.',
        }).catch(() => {});
      }

      setConfirmCancelLeague(false);
      await Promise.all([fetchLobby(selectedLeagueId), fetchLeagues()]);
      showSuccess('League closed and cancelled.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to close league');
    } finally {
      setBusy(false);
    }
  };

  const handleStartAuction = async () => {
    if (!selectedLeagueId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/auctions/${selectedLeagueId}/start`, { method: 'POST' });
      if (firebaseUser?.uid && dbUser?.profile) {
        await updateLeagueStatusFirestore({
          leagueId: selectedLeagueId,
          actorUid: firebaseUser.uid,
          actorName: dbUser.profile.displayName,
          nextStatus: 'AUCTION_IN_PROGRESS',
          actionType: 'AUCTION_STARTED',
          message: 'Player auction launched.',
        }).catch(() => {});
      }
      onEnterAuction(selectedLeagueId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start auction');
    } finally {
      setBusy(false);
    }
  };

  const filteredMyLeagues = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return myLeagues.filter((l) => {
      const matchStatus =
        statusFilter === 'ALL' ||
        l.status === statusFilter ||
        (statusFilter === 'OPEN' && (l.status === 'LOBBY' || l.status === 'CREATED')) ||
        (statusFilter === 'AUCTION_IN_PROGRESS' && l.status === 'AUCTION_LIVE');
      const matchSearch =
        !q ||
        l.name.toLowerCase().includes(q) ||
        l.id.toLowerCase().includes(q) ||
        (l.ownerName || '').toLowerCase().includes(q);
      return matchStatus && matchSearch;
    });
  }, [myLeagues, searchTerm, statusFilter]);

  const filteredPublicLeagues = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return publicLeagues.filter((l) => {
      if (!q) return true;
      return (
        l.name.toLowerCase().includes(q) ||
        l.id.toLowerCase().includes(q) ||
        (l.ownerName || '').toLowerCase().includes(q)
      );
    });
  }, [publicLeagues, searchTerm]);

  const myMember = lobbyDetails?.members.find((m) => m.userId === dbUser?.id);
  const myTeam = lobbyDetails?.teams.find((t) => t.ownerId === dbUser?.id);
  const isHost = lobbyDetails?.league.ownerId === dbUser?.id;
  const isPreAuction = lobbyDetails ? PRE_AUCTION_SET.has(lobbyDetails.league.status) : false;
  const canCustomizeTeam =
    Boolean(myTeam) &&
    isPreAuction &&
    (isHost || (lobbyDetails?.settings?.allowTeamCustomization ?? true));

  const incomingDirectInvites = pendingInvitations.filter(
    (i) => i.type === 'DIRECT_INVITE' && i.recipientId === dbUser?.id
  );
  const incomingJoinRequests = pendingInvitations.filter(
    (i) => i.type === 'JOIN_REQUEST' && i.recipientId === dbUser?.id
  );
  const outgoingInvitesAndRequests = pendingInvitations.filter(
    (i) => i.senderId === dbUser?.id
  );

  const shareableInviteLink =
    lobbyDetails?.league.inviteCode
      ? `${window.location.origin}/?invite=${lobbyDetails.league.inviteCode}`
      : '';

  return (
    <div className="space-y-6">
      {/* Header & Top Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Multiplayer Leagues</h1>
          <p className="text-sm text-slate-400">
            Create 2–12 team leagues, manage invitations &amp; franchise rosters, and coordinate live auctions.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#0B1325] rounded-lg border border-slate-800 self-start">
          <button
            onClick={() => setMode('BROWSE')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              mode === 'BROWSE' ? 'bg-amber-500 text-slate-950' : 'text-slate-300 hover:text-white'
            }`}
          >
            League Dashboard
          </button>
          <button
            onClick={() => {
              setMode('CREATE');
              setError(null);
            }}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              mode === 'CREATE' ? 'bg-amber-500 text-slate-950' : 'text-slate-300 hover:text-white'
            }`}
          >
            Create League
          </button>
          <button
            onClick={() => {
              setMode('JOIN');
              setError(null);
            }}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              mode === 'JOIN' ? 'bg-amber-500 text-slate-950' : 'text-slate-300 hover:text-white'
            }`}
          >
            Join League
          </button>
        </div>
      </div>

      {/* Inline Feedback Banners */}
      {error && (
        <div className="p-3.5 rounded-lg bg-red-950/60 border border-red-800/80 text-xs text-red-200 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {successMsg && (
        <div className="p-3.5 rounded-lg bg-emerald-950/60 border border-emerald-800/80 text-xs text-emerald-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{successMsg}</span>
          </div>
          <button onClick={() => setSuccessMsg(null)} className="text-emerald-300 hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* CREATE NEW LEAGUE WORKFLOW */}
      {mode === 'CREATE' && (
        <form
          onSubmit={handleCreateLeague}
          className="p-6 rounded-xl bg-[#0B1325] border border-slate-800 space-y-6"
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <h2 className="text-lg font-display font-bold text-white">Create New Cricket League</h2>
              <p className="text-xs text-slate-400">
                You will automatically become the League Owner and receive a unique League ID and secure invite code.
              </p>
            </div>
            <span className="text-xs font-mono-num text-amber-400">{visibility}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs text-slate-400 mb-1">League Name *</label>
              <input
                type="text"
                required
                minLength={3}
                maxLength={60}
                value={leagueName}
                onChange={(e) => setLeagueName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">League Visibility</label>
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as 'PRIVATE' | 'PUBLIC')}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
              >
                <option value="PRIVATE">Private (Invite Code / Request)</option>
                <option value="PUBLIC">Public (Open Directory)</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs text-slate-400 mb-1">League Description</label>
              <input
                type="text"
                maxLength={300}
                value={leagueDescription}
                onChange={(e) => setLeagueDescription(e.target.value)}
                placeholder="Season rules, schedule notes, or tournament stakes..."
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">League Crest / Banner</label>
              <select
                value={leagueLogoUrl}
                onChange={(e) => setLeagueLogoUrl(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
              >
                {PRESET_LOGOS.map((p) => (
                  <option key={p.url} value={p.url}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Max Participants (2–12)</label>
              <select
                value={maxTeams}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setMaxTeams(val);
                  setNumberOfTeams(val);
                }}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
              >
                {[2, 3, 4, 5, 6, 8, 10, 12].map((n) => (
                  <option key={n} value={n}>
                    {n} Participants
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Number of Teams</label>
              <input
                type="number"
                min={2}
                max={12}
                value={numberOfTeams}
                onChange={(e) => setNumberOfTeams(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Starting Virtual Purse (Lakhs)</label>
              <input
                type="number"
                min={1000}
                max={100000}
                step={500}
                value={purseAmount}
                onChange={(e) => setPurseAmount(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
              />
              <span className="text-[11px] text-slate-500 mt-0.5 block">
                {formatCurrency(purseAmount)} per franchise
              </span>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Min Players Required</label>
              <input
                type="number"
                min={11}
                max={25}
                value={minSquadSize}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMinSquadSize(v);
                  if (maxSquadSize < v) setMaxSquadSize(v);
                }}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Max Players Allowed / Squad Size</label>
              <input
                type="number"
                min={minSquadSize}
                max={25}
                value={maxSquadSize}
                onChange={(e) => setMaxSquadSize(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Auction Bid Increment (Lakhs)</label>
              <input
                type="number"
                min={5}
                max={500}
                step={5}
                value={bidIncrement}
                onChange={(e) => setBidIncrement(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Auction Timer Duration (sec)</label>
              <input
                type="number"
                min={5}
                max={60}
                value={timerSeconds}
                onChange={(e) => setTimerSeconds(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Auction Pool Format</label>
              <select
                value={auctionMode}
                onChange={(e) => setAuctionMode(e.target.value as 'MEGA' | 'MINI' | 'FAST_TRACK')}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
              >
                <option value="MEGA">Mega Auction (120 Players)</option>
                <option value="MINI">Mini Auction (60 Players)</option>
                <option value="FAST_TRACK">Fast Track (30 Players)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Invite Code Expiration</label>
              <select
                value={inviteExpiryHours}
                onChange={(e) => setInviteExpiryHours(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
              >
                <option value={24}>24 Hours</option>
                <option value={72}>72 Hours (Default)</option>
                <option value={168}>7 Days</option>
                <option value={0}>No Expiration</option>
              </select>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-800 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-white">Pre-Auction Squad Composition Rules</h3>
              <p className="text-xs text-slate-400">
                Validated when teams mark their squad complete (does not block live auction bids mid-round).
              </p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Max Overseas</label>
                <input
                  type="number"
                  min={0}
                  max={11}
                  value={maxOverseas}
                  onChange={(e) => setMaxOverseas(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Min Wicketkeepers</label>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={minWicketkeepers}
                  onChange={(e) => setMinWicketkeepers(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Min Batsmen</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={minBatsmen}
                  onChange={(e) => setMinBatsmen(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Min Bowlers</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={minBowlers}
                  onChange={(e) => setMinBowlers(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Min All-Rounders</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={minAllRounders}
                  onChange={(e) => setMinAllRounders(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
                />
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-800 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <h3 className="text-sm font-semibold text-white">Your Franchise Assignment</h3>
              <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowTeamCustomization}
                  onChange={(e) => setAllowTeamCustomization(e.target.checked)}
                  className="rounded border-slate-600 bg-[#060B18] text-amber-500"
                />
                <span>Allow members to customize team name &amp; crest pre-auction</span>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Franchise Team Name *</label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={40}
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Short Tag (2–4 chars) *</label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={4}
                  value={teamShortName}
                  onChange={(e) => setTeamShortName(e.target.value.toUpperCase())}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num uppercase"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Team Crest</label>
                <select
                  value={teamLogoUrl}
                  onChange={(e) => setTeamLogoUrl(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
                >
                  {PRESET_LOGOS.map((p) => (
                    <option key={p.url} value={p.url}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => setMode('BROWSE')}
              className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-5 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>{busy ? 'Creating League...' : 'Create League & Open Lobby'}</span>
            </button>
          </div>
        </form>
      )}

      {/* JOIN LEAGUE WORKFLOW (Code / Shareable Link / Request Private League) */}
      {mode === 'JOIN' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={handleJoinByCode}
            className="lg:col-span-7 p-6 rounded-xl bg-[#0B1325] border border-slate-800 space-y-5"
          >
            <div>
              <h2 className="text-lg font-display font-bold text-white">Join via Invitation Code or Link</h2>
              <p className="text-xs text-slate-400">
                Paste a CV-XXXXXX code or full shareable invitation link to preview and claim your franchise.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                required
                value={inviteCode}
                onChange={(e) => {
                  const extracted = extractInviteCodeFromInput(e.target.value);
                  setInviteCode(extracted);
                }}
                placeholder="CV-XXXXXX or https://.../?invite=CV-XXXXXX"
                className="flex-1 px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num uppercase"
              />
              <button
                type="button"
                onClick={() => handlePreviewInviteCode(inviteCode)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-amber-400 whitespace-nowrap cursor-pointer"
              >
                Verify Code
              </button>
            </div>

            {previewLeague && (
              <div className="p-4 rounded-lg bg-[#060B18] border border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className={statusTextColor(previewLeague.league.status)}>
                    {normalizeStatusLabel(previewLeague.league.status)} · {previewLeague.league.visibility}
                  </span>
                  <span className="font-mono-num text-slate-400">
                    {previewLeague.league.memberCount}/{previewLeague.league.maxTeams} Teams
                  </span>
                </div>
                <div className="text-base font-display font-bold text-white">
                  {previewLeague.league.name}
                </div>
                <div className="text-xs text-slate-400">
                  Owner: {previewLeague.league.ownerName} ({previewLeague.league.ownerPlayerId}) · Purse:{' '}
                  <span className="font-mono-num text-emerald-400">
                    {formatCurrency(previewLeague.league.purseAmount)}
                  </span>
                </div>
                {previewLeague.alreadyMember && (
                  <div className="text-xs text-amber-400">You are already a member of this league.</div>
                )}
                {previewLeague.isFull && !previewLeague.alreadyMember && (
                  <div className="text-xs text-red-400">This league has reached its maximum capacity.</div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Your Franchise Name</label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={40}
                  value={joinTeamName}
                  onChange={(e) => setJoinTeamName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Short Tag</label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={4}
                  value={joinShortName}
                  onChange={(e) => setJoinShortName(e.target.value.toUpperCase())}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num uppercase"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Team Crest</label>
                <select
                  value={joinTeamLogoUrl}
                  onChange={(e) => setJoinTeamLogoUrl(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white"
                >
                  {PRESET_LOGOS.map((p) => (
                    <option key={p.url} value={p.url}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setMode('BROWSE')}
                className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold cursor-pointer"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold cursor-pointer"
              >
                {busy ? 'Joining...' : 'Join League & Claim Team'}
              </button>
            </div>
          </form>

          {/* Request Access to Private League by League ID */}
          <div className="lg:col-span-5 p-6 rounded-xl bg-[#0B1325] border border-slate-800 space-y-4">
            <h3 className="text-base font-display font-bold text-white">Request Private League Access</h3>
            <p className="text-xs text-slate-400">
              Don&apos;t have the invite code? Enter a League ID to send a permission request directly to the League Owner.
            </p>
            <input
              type="text"
              value={requestLeagueIdInput}
              onChange={(e) => setRequestLeagueIdInput(e.target.value)}
              placeholder="Paste League ID (UUID)"
              className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white font-mono-num"
            />
            <button
              type="button"
              disabled={busy || !requestLeagueIdInput.trim()}
              onClick={() => handleRequestJoinPrivate(requestLeagueIdInput)}
              className="w-full py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-45 text-xs font-semibold text-amber-400 cursor-pointer"
            >
              Send Join Request to Owner
            </button>
          </div>
        </div>
      )}

      {/* MAIN SPLIT DASHBOARD + LOBBY WORKSPACE */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Search, My Leagues, Public Leagues, Pending Invitations, Recent Activity */}
        <div className="lg:col-span-5 space-y-6">
          {/* Search & Status Filter */}
          <div className="p-3 rounded-xl bg-[#0B1325] border border-slate-800/80 flex flex-col sm:flex-row gap-2.5">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search league name, ID, or owner..."
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#060B18] border border-slate-800 text-xs text-white"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-800 text-xs text-slate-200"
            >
              <option value="ALL">All Statuses</option>
              <option value="OPEN">Open</option>
              <option value="FULL">Full</option>
              <option value="READY">Ready</option>
              <option value="AUCTION_IN_PROGRESS">Auction Live</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>

          {/* Pending Invitations & Join Requests */}
          {(incomingDirectInvites.length > 0 ||
            incomingJoinRequests.length > 0 ||
            outgoingInvitesAndRequests.length > 0) && (
            <div className="p-4 rounded-xl bg-[#0B1325] border border-amber-500/30 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-amber-400 flex items-center gap-1.5">
                  <UserPlus className="w-4 h-4" />
                  <span>Pending Invitations &amp; Requests ({pendingInvitations.length})</span>
                </h2>
              </div>

              <div className="space-y-2.5">
                {incomingDirectInvites.map((inv) => (
                  <div
                    key={inv.id}
                    className="p-3 rounded-lg bg-[#060B18] border border-slate-800 space-y-2"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-white">{inv.leagueName}</span>
                      <span className="font-mono-num text-amber-400">INVITE</span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      From {inv.senderName} ({inv.senderPlayerId})
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        disabled={busy}
                        onClick={() => handleRespondInvitation(inv, 'ACCEPT')}
                        className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer"
                      >
                        Accept &amp; Join
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => handleRespondInvitation(inv, 'REJECT')}
                        className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold cursor-pointer"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}

                {incomingJoinRequests.map((req) => (
                  <div
                    key={req.id}
                    className="p-3 rounded-lg bg-[#060B18] border border-slate-800 space-y-2"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-white">{req.leagueName}</span>
                      <span className="font-mono-num text-sky-400">JOIN REQUEST</span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Requester: {req.senderName} ({req.senderPlayerId})
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        disabled={busy}
                        onClick={() => handleRespondInvitation(req, 'ACCEPT')}
                        className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer"
                      >
                        Approve
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => handleRespondInvitation(req, 'REJECT')}
                        className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold cursor-pointer"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}

                {outgoingInvitesAndRequests.map((inv) => (
                  <div
                    key={inv.id}
                    className="p-3 rounded-lg bg-[#060B18] border border-slate-800 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-slate-200 truncate">
                        {inv.type === 'JOIN_REQUEST'
                          ? `Request to join ${inv.leagueName}`
                          : `Invited ${inv.recipientName} (${inv.recipientPlayerId})`}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">{inv.leagueName}</div>
                    </div>
                    <button
                      disabled={busy}
                      onClick={() => handleRespondInvitation(inv, 'REVOKE')}
                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-red-950/80 text-[11px] text-red-300 shrink-0 cursor-pointer"
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* My Leagues */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-300">
                My Leagues ({filteredMyLeagues.length})
              </h2>
            </div>

            {filteredMyLeagues.length === 0 ? (
              <div className="p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 text-xs text-slate-400">
                No matching leagues. Create a private league or join via code.
              </div>
            ) : (
              <div className="space-y-2.5">
                {filteredMyLeagues.map((l) => {
                  const active = selectedLeagueId === l.id;
                  return (
                    <button
                      key={l.id}
                      onClick={() => onSelectLeague(l.id)}
                      className={`w-full text-left p-4 rounded-xl border transition-colors cursor-pointer ${
                        active
                          ? 'bg-[#101C36] border-amber-500/60'
                          : 'bg-[#0B1325] border-slate-800/80 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <img
                          src={l.logoUrl || PRESET_LOGOS[0].url}
                          alt={l.name}
                          referrerPolicy="no-referrer"
                          className="w-11 h-11 rounded-lg object-cover border border-slate-800 shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className={`font-semibold ${statusTextColor(l.status)}`}>
                              {normalizeStatusLabel(l.status)}
                              <span className="text-slate-500"> · {l.visibility}</span>
                            </span>
                            <span className="font-mono-num text-amber-400">{l.inviteCode}</span>
                          </div>
                          <div className="mt-0.5 font-display font-semibold text-white truncate">
                            {l.name}
                          </div>
                          <div className="mt-1 text-xs text-slate-400 flex flex-wrap items-center gap-x-2 font-mono-num">
                            <span>
                              {l.memberCount ?? 1}/{l.maxTeams} Teams
                            </span>
                            <span aria-hidden="true">·</span>
                            <span>{formatCurrency(l.purseAmount)}</span>
                            <span aria-hidden="true">·</span>
                            <span className="truncate font-sans text-slate-400">
                              Owner: {l.ownerName || 'Host'}
                            </span>
                          </div>
                          <div className="mt-1 text-[10px] font-mono-num text-slate-500 truncate">
                            ID: {l.id}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Public Leagues Directory */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-1.5">
              <Globe className="w-4 h-4 text-emerald-400" />
              <span>Public Leagues ({filteredPublicLeagues.length})</span>
            </h2>
            {filteredPublicLeagues.length === 0 ? (
              <div className="p-4 rounded-xl bg-[#0B1325] border border-slate-800/80 text-xs text-slate-500">
                No other public leagues open right now.
              </div>
            ) : (
              <div className="space-y-2.5">
                {filteredPublicLeagues.map((l) => {
                  const full = (l.memberCount ?? 1) >= l.maxTeams || l.status === 'FULL';
                  const openJoin = !full && PRE_AUCTION_SET.has(l.status);
                  return (
                    <div
                      key={l.id}
                      className="p-4 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className={statusTextColor(l.status)}>
                              {normalizeStatusLabel(l.status)}
                            </span>
                            <span className="text-slate-500">· Owner: {l.ownerName}</span>
                          </div>
                          <div className="font-semibold text-sm text-white truncate">{l.name}</div>
                          <div className="text-xs text-slate-400 font-mono-num">
                            {l.memberCount ?? 1}/{l.maxTeams} Teams · {formatCurrency(l.purseAmount)} ·{' '}
                            {l.id.slice(0, 8)}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => onSelectLeague(l.id)}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-300 hover:text-white cursor-pointer"
                          >
                            Inspect
                          </button>
                          {openJoin && (
                            <button
                              onClick={() =>
                                setQuickJoinPublicId((prev) => (prev === l.id ? null : l.id))
                              }
                              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white cursor-pointer"
                            >
                              Join
                            </button>
                          )}
                        </div>
                      </div>

                      {quickJoinPublicId === l.id && (
                        <div className="pt-3 border-t border-slate-800 grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <input
                            type="text"
                            value={joinTeamName}
                            onChange={(e) => setJoinTeamName(e.target.value)}
                            placeholder="Team Name"
                            className="px-2.5 py-1.5 rounded bg-[#060B18] border border-slate-700 text-xs text-white"
                          />
                          <input
                            type="text"
                            maxLength={4}
                            value={joinShortName}
                            onChange={(e) => setJoinShortName(e.target.value.toUpperCase())}
                            placeholder="TAG"
                            className="px-2.5 py-1.5 rounded bg-[#060B18] border border-slate-700 text-xs text-white font-mono-num uppercase"
                          />
                          <button
                            disabled={busy}
                            onClick={() => handleJoinPublicLeague(l.id)}
                            className="px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
                          >
                            Confirm Join
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent League Activity */}
          <div className="p-4 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-3">
            <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-1.5">
              <Activity className="w-4 h-4 text-amber-400" />
              <span>Recent League Activity</span>
            </h2>
            {recentActivity.length === 0 ? (
              <div className="text-xs text-slate-500">No recent activity across your leagues yet.</div>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {recentActivity.slice(0, 10).map((act) => (
                  <div key={act.id} className="text-xs border-l-2 border-slate-800 pl-3 py-0.5">
                    <div className="text-slate-200">{act.message}</div>
                    <div className="text-[11px] text-slate-500">
                      {act.leagueName} · {new Date(act.createdAt).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Selected League Lobby Workspace */}
        <div className="lg:col-span-7">
          {!lobbyDetails ? (
            <div className="p-10 rounded-xl bg-[#0B1325] border border-slate-800/80 text-center space-y-3">
              <Users className="w-9 h-9 text-slate-500 mx-auto" />
              <div className="text-base font-display font-semibold text-slate-200">
                Select a League Lobby
              </div>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Choose any league on the left to inspect franchise teams, invite friends by CricketVerse Player ID, customize your squad branding, or manage auction readiness.
              </p>
            </div>
          ) : (
            <div className="p-6 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-6">
              {/* League Hero & Lifecycle Status */}
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 pb-5 border-b border-slate-800/80">
                <div className="flex items-start gap-3.5">
                  <img
                    src={lobbyDetails.league.logoUrl || PRESET_LOGOS[0].url}
                    alt={lobbyDetails.league.name}
                    referrerPolicy="no-referrer"
                    className="w-14 h-14 rounded-xl object-cover border border-slate-700 shrink-0"
                  />
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={`font-bold ${statusTextColor(lobbyDetails.league.status)}`}>
                        {normalizeStatusLabel(lobbyDetails.league.status)}
                      </span>
                      <span className="text-slate-600">·</span>
                      <span className="text-slate-400 inline-flex items-center gap-1">
                        {lobbyDetails.league.visibility === 'PRIVATE' ? (
                          <Lock className="w-3 h-3" />
                        ) : (
                          <Globe className="w-3 h-3" />
                        )}
                        {lobbyDetails.league.visibility}
                      </span>
                      <span className="text-slate-600">·</span>
                      <span className="text-slate-400">{lobbyDetails.league.auctionMode}</span>
                      <span className="text-slate-600">·</span>
                      <span className="text-slate-400 font-mono-num">
                        {lobbyDetails.league.timerSeconds}s Clock
                      </span>
                    </div>
                    <h2 className="text-xl font-display font-bold text-white">
                      {lobbyDetails.league.name}
                    </h2>
                    {lobbyDetails.league.description && (
                      <p className="text-xs text-slate-400">{lobbyDetails.league.description}</p>
                    )}
                    <div className="text-xs text-slate-300 font-mono-num flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span>Purse: {formatCurrency(lobbyDetails.league.purseAmount)}</span>
                      <span>·</span>
                      <span>
                        Squad: {lobbyDetails.league.minSquadSize}–{lobbyDetails.league.maxSquadSize}
                      </span>
                      <span>·</span>
                      <span>Increment: {formatCurrency(lobbyDetails.league.bidIncrement)}</span>
                      {lobbyDetails.settings && (
                        <>
                          <span>·</span>
                          <span>
                            Min {lobbyDetails.settings.minBatsmen} BAT / {lobbyDetails.settings.minBowlers} BWL /{' '}
                            {lobbyDetails.settings.minAllRounders} AR / {lobbyDetails.settings.minWicketkeepers} WK · Max{' '}
                            {lobbyDetails.settings.maxOverseas} OS
                          </span>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono-num">
                      <span>League ID: {lobbyDetails.league.id}</span>
                      <button
                        onClick={() => copyText('lid', lobbyDetails.league.id)}
                        className="text-amber-400 hover:text-amber-300 cursor-pointer"
                        title="Copy League ID"
                      >
                        {copiedFlag === 'lid' ? 'Copied' : 'Copy ID'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Primary Lobby Action Buttons */}
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {lobbyDetails.league.status === 'CANCELLED' ? (
                    <span className="text-xs font-semibold text-red-400">League Closed</span>
                  ) : !isPreAuction ? (
                    <button
                      onClick={() => onEnterAuction(lobbyDetails.league.id)}
                      className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <Gavel className="w-4 h-4" />
                      <span>Enter Auction Room</span>
                    </button>
                  ) : isHost ? (
                    <>
                      <button
                        onClick={() =>
                          handleMarkLeagueReady(lobbyDetails.league.status !== 'READY')
                        }
                        disabled={busy || lobbyDetails.teams.length < 2}
                        className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-45 text-xs font-semibold text-sky-300 cursor-pointer"
                      >
                        {lobbyDetails.league.status === 'READY' ? 'Reopen Lobby' : 'Mark Ready'}
                      </button>
                      <button
                        onClick={handleStartAuction}
                        disabled={busy || lobbyDetails.teams.length < 2}
                        className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-bold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        <Gavel className="w-4 h-4" />
                        <span>
                          {lobbyDetails.teams.length < 2 ? 'Need 2+ Teams' : 'Start Auction'}
                        </span>
                      </button>
                    </>
                  ) : myMember ? (
                    <button
                      onClick={() => handleToggleReady(myMember.isReady)}
                      className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                        myMember.isReady
                          ? 'bg-emerald-600 text-white'
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                      }`}
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>{myMember.isReady ? 'Ready' : 'Mark Ready'}</span>
                    </button>
                  ) : lobbyDetails.league.visibility === 'PUBLIC' &&
                    lobbyDetails.teams.length < lobbyDetails.league.maxTeams ? (
                    <button
                      onClick={() => handleJoinPublicLeague(lobbyDetails.league.id)}
                      disabled={busy}
                      className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold cursor-pointer"
                    >
                      Join Public League
                    </button>
                  ) : null}
                </div>
              </div>

              {/* Controlled Status Pipeline Strip */}
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono-num">
                {(['OPEN', 'FULL', 'READY', 'AUCTION_IN_PROGRESS', 'COMPLETED'] as LeagueStatus[]).map(
                  (stage, idx) => {
                    const currentNormalized =
                      lobbyDetails.league.status === 'LOBBY' || lobbyDetails.league.status === 'CREATED'
                        ? 'OPEN'
                        : lobbyDetails.league.status === 'AUCTION_LIVE'
                        ? 'AUCTION_IN_PROGRESS'
                        : lobbyDetails.league.status;
                    const active = currentNormalized === stage;
                    return (
                      <React.Fragment key={stage}>
                        {idx > 0 && <span className="text-slate-700">/</span>}
                        <span
                          className={
                            active
                              ? 'text-amber-400 font-bold underline underline-offset-4'
                              : 'text-slate-500'
                          }
                        >
                          {stage.replace(/_/g, ' ')}
                        </span>
                      </React.Fragment>
                    );
                  }
                )}
                {lobbyDetails.league.status === 'CANCELLED' && (
                  <>
                    <span className="text-slate-700">/</span>
                    <span className="text-red-400 font-bold">CANCELLED</span>
                  </>
                )}
              </div>

              {/* Invitation Code & Shareable Link Box (visible to members) */}
              {myMember && (
                <div className="p-4 rounded-xl bg-[#060B18] border border-slate-800 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold text-slate-300">
                        Invitation Code &amp; Shareable Link
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {lobbyDetails.league.inviteCodeActive === false
                          ? 'Invite code is currently revoked.'
                          : lobbyDetails.league.inviteCodeExpiresAt
                          ? `Expires: ${new Date(lobbyDetails.league.inviteCodeExpiresAt).toLocaleString()}`
                          : 'Active until revoked or auction starts.'}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => copyText('code', lobbyDetails.league.inviteCode)}
                        className="px-3 py-1.5 rounded-lg bg-[#0B1325] border border-slate-700 text-xs font-mono-num text-amber-400 flex items-center gap-1.5 cursor-pointer"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        <span>
                          {copiedFlag === 'code' ? 'Copied Code!' : lobbyDetails.league.inviteCode}
                        </span>
                      </button>

                      <button
                        onClick={() => copyText('link', shareableInviteLink)}
                        className="px-3 py-1.5 rounded-lg bg-[#0B1325] border border-slate-700 text-xs text-slate-200 hover:text-white flex items-center gap-1.5 cursor-pointer"
                      >
                        <Link2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span>{copiedFlag === 'link' ? 'Link Copied!' : 'Copy Invite Link'}</span>
                      </button>

                      {isHost && isPreAuction && (
                        <>
                          <button
                            onClick={handleRegenerateInviteCode}
                            disabled={busy}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1 cursor-pointer"
                            title="Generate a new invite code"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            <span>Regenerate</span>
                          </button>
                          {lobbyDetails.league.inviteCodeActive !== false && (
                            <button
                              onClick={handleRevokeInviteCode}
                              disabled={busy}
                              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-red-950 text-xs text-red-300 flex items-center gap-1 cursor-pointer"
                              title="Revoke active invite code"
                            >
                              <Ban className="w-3.5 h-3.5" />
                              <span>Revoke</span>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Team Assignment & Members Roster Table */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-300">
                    Franchise Teams &amp; Members ({lobbyDetails.teams.length} / {lobbyDetails.league.maxTeams})
                  </h3>
                  {canCustomizeTeam && myTeam && (
                    <button
                      onClick={() => {
                        setCustomTeamName(myTeam.name);
                        setCustomShortName(myTeam.shortName);
                        setCustomColor(myTeam.primaryColor);
                        setCustomTeamLogo(myTeam.logoUrl || PRESET_LOGOS[2].url);
                        setEditingTeam((v) => !v);
                      }}
                      className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1 cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>{editingTeam ? 'Close Team Editor' : 'Customize My Team'}</span>
                    </button>
                  )}
                </div>

                {/* Inline Member Team Customization Panel */}
                {editingTeam && canCustomizeTeam && (
                  <form
                    onSubmit={handleSaveTeamCustomization}
                    className="p-4 rounded-xl bg-[#060B18] border border-amber-500/30 space-y-3"
                  >
                    <div className="text-xs font-semibold text-white">Customize Your Franchise</div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <input
                        type="text"
                        required
                        minLength={2}
                        maxLength={40}
                        value={customTeamName}
                        onChange={(e) => setCustomTeamName(e.target.value)}
                        placeholder="Franchise Name"
                        className="px-3 py-2 rounded-lg bg-[#0B1325] border border-slate-700 text-xs text-white"
                      />
                      <input
                        type="text"
                        required
                        minLength={2}
                        maxLength={4}
                        value={customShortName}
                        onChange={(e) => setCustomShortName(e.target.value.toUpperCase())}
                        placeholder="Short Tag"
                        className="px-3 py-2 rounded-lg bg-[#0B1325] border border-slate-700 text-xs text-white font-mono-num uppercase"
                      />
                      <select
                        value={customTeamLogo}
                        onChange={(e) => setCustomTeamLogo(e.target.value)}
                        className="px-3 py-2 rounded-lg bg-[#0B1325] border border-slate-700 text-xs text-white"
                      >
                        {PRESET_LOGOS.map((p) => (
                          <option key={p.url} value={p.url}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-slate-400">Team Color:</span>
                        {TEAM_COLORS.map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => setCustomColor(c)}
                            className={`w-5 h-5 rounded-full border-2 cursor-pointer ${
                              customColor === c ? 'border-white scale-110' : 'border-transparent'
                            }`}
                            style={{ backgroundColor: c }}
                            aria-label={`Color ${c}`}
                          />
                        ))}
                      </div>
                      <button
                        type="submit"
                        disabled={busy}
                        className="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
                      >
                        Save Franchise
                      </button>
                    </div>
                  </form>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="py-2 pr-3 font-medium">Franchise</th>
                        <th className="py-2 px-3 font-medium">Owner</th>
                        <th className="py-2 px-3 font-medium text-right">Remaining Purse</th>
                        <th className="py-2 px-3 font-medium text-right">Players</th>
                        <th className="py-2 px-3 font-medium text-right">Ready</th>
                        {isHost && isPreAuction && (
                          <th className="py-2 pl-3 font-medium text-right">Manage</th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {lobbyDetails.teams.map((t) => {
                        const m = lobbyDetails.members.find((mem) => mem.userId === t.ownerId);
                        const rowIsOwner = m?.role === 'OWNER';
                        return (
                          <tr key={t.id}>
                            <td className="py-2.5 pr-3">
                              <div className="flex items-center gap-2.5">
                                <img
                                  src={t.logoUrl || PRESET_LOGOS[2].url}
                                  alt={t.name}
                                  referrerPolicy="no-referrer"
                                  className="w-7 h-7 rounded-md object-cover border border-slate-800 shrink-0"
                                />
                                <div>
                                  <div className="flex items-center gap-1.5">
                                    <span
                                      className="w-2 h-2 rounded-full shrink-0"
                                      style={{ backgroundColor: t.primaryColor }}
                                    />
                                    <span className="font-semibold text-white">{t.name}</span>
                                    <span className="font-mono-num text-slate-500">({t.shortName})</span>
                                  </div>
                                  <div className="text-[10px] text-slate-500 font-mono-num">
                                    Squad: {t.squadStatus || 'UNFILLED'}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="py-2.5 px-3 text-slate-300">
                              <div className="flex items-center gap-1">
                                {rowIsOwner && <Crown className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                                <span>{m?.displayName || t.ownerName || 'Owner'}</span>
                              </div>
                              <div className="text-[11px] text-slate-500 font-mono-num">
                                {m?.uniquePlayerId || t.ownerPlayerId}
                              </div>
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono-num text-emerald-400">
                              {formatCurrency(t.remainingPurse)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono-num text-slate-300">
                              {t.squadCount}/{lobbyDetails.league.maxSquadSize}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <span
                                className={
                                  rowIsOwner
                                    ? 'text-amber-400 font-semibold'
                                    : m?.isReady
                                    ? 'text-emerald-400 font-semibold'
                                    : 'text-slate-400'
                                }
                              >
                                {rowIsOwner ? 'Host' : m?.isReady ? 'Ready' : 'Waiting'}
                              </span>
                            </td>
                            {isHost && isPreAuction && (
                              <td className="py-2.5 pl-3 text-right">
                                {!rowIsOwner && m && (
                                  <div className="inline-flex items-center gap-1.5">
                                    {confirmTransferUid === m.userId ? (
                                      <button
                                        disabled={busy}
                                        onClick={() => handleTransferOwnership(m)}
                                        className="px-2 py-1 rounded bg-amber-500 text-slate-950 text-[11px] font-bold cursor-pointer"
                                      >
                                        Confirm Host
                                      </button>
                                    ) : (
                                      <button
                                        onClick={() => setConfirmTransferUid(m.userId)}
                                        className="p-1.5 rounded bg-slate-900 border border-slate-700 text-amber-400 hover:border-amber-500 cursor-pointer"
                                        title="Transfer League Ownership"
                                      >
                                        <ArrowRightLeft className="w-3 h-3" />
                                      </button>
                                    )}

                                    {confirmRemoveUid === m.userId ? (
                                      <button
                                        disabled={busy}
                                        onClick={() => handleRemoveMember(m)}
                                        className="px-2 py-1 rounded bg-red-600 text-white text-[11px] font-bold cursor-pointer"
                                      >
                                        Confirm Remove
                                      </button>
                                    ) : (
                                      <button
                                        onClick={() => setConfirmRemoveUid(m.userId)}
                                        className="p-1.5 rounded bg-slate-900 border border-slate-700 text-red-400 hover:border-red-500 cursor-pointer"
                                        title="Remove Member"
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    )}
                                  </div>
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Invitation Center Inside Lobby (Invite by CV Player ID + Friends + League Pending Queue) */}
              {myMember && isPreAuction && lobbyDetails.league.status !== 'CANCELLED' && (
                <div className="pt-5 border-t border-slate-800/80 space-y-4">
                  <h3 className="text-xs font-semibold text-slate-300">
                    Invite Players &amp; Friends
                  </h3>

                  <form onSubmit={handleInviteByPlayerId} className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={invitePlayerIdInput}
                      onChange={(e) => setInvitePlayerIdInput(e.target.value.toUpperCase())}
                      placeholder="Enter CricketVerse Player ID (e.g. CV100002)"
                      className="flex-1 px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-xs text-white font-mono-num uppercase"
                    />
                    <button
                      type="submit"
                      disabled={busy || !invitePlayerIdInput.trim()}
                      className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-45 text-slate-950 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>Send Invite</span>
                    </button>
                  </form>

                  {friends.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {friends.map((f) => {
                        const alreadyIn = lobbyDetails.members.some((m) => m.userId === f.userId);
                        const alreadyInvited = lobbyDetails.invitations.some(
                          (i) => i.recipientId === f.userId && i.status === 'PENDING'
                        );
                        return (
                          <button
                            key={f.friendshipId}
                            disabled={alreadyIn || alreadyInvited || busy}
                            onClick={() => handleInviteFriend(f)}
                            className="px-3 py-1.5 rounded-lg bg-[#060B18] border border-slate-700 hover:border-amber-500/60 disabled:opacity-45 text-xs text-slate-200 flex items-center gap-1.5 cursor-pointer"
                          >
                            <Send className="w-3 h-3 text-amber-400" />
                            <span>{f.displayName}</span>
                            <span className="font-mono-num text-[10px] text-slate-500">
                              {f.uniquePlayerId}
                            </span>
                            {alreadyIn && <span className="text-emerald-400">(Joined)</span>}
                            {alreadyInvited && <span className="text-amber-400">(Invited)</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {lobbyDetails.invitations.length > 0 && (
                    <div className="space-y-2 pt-2">
                      <div className="text-[11px] font-semibold text-slate-400">
                        Pending League Invitations &amp; Join Requests ({lobbyDetails.invitations.length})
                      </div>
                      {lobbyDetails.invitations.map((inv) => (
                        <div
                          key={inv.id}
                          className="p-2.5 rounded-lg bg-[#060B18] border border-slate-800 flex items-center justify-between gap-2 text-xs"
                        >
                          <div>
                            {inv.type === 'JOIN_REQUEST' ? (
                              <span className="text-sky-300">
                                Join Request from {inv.senderName} ({inv.senderPlayerId})
                              </span>
                            ) : (
                              <span className="text-slate-300">
                                Invite sent to {inv.recipientName} ({inv.recipientPlayerId})
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {isHost && inv.type === 'JOIN_REQUEST' && (
                              <>
                                <button
                                  disabled={busy}
                                  onClick={() => handleRespondInvitation(inv, 'ACCEPT')}
                                  className="px-2.5 py-1 rounded bg-emerald-600 text-white text-[11px] font-semibold cursor-pointer"
                                >
                                  Approve
                                </button>
                                <button
                                  disabled={busy}
                                  onClick={() => handleRespondInvitation(inv, 'REJECT')}
                                  className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 text-[11px] cursor-pointer"
                                >
                                  Reject
                                </button>
                              </>
                            )}
                            {(isHost || inv.senderId === dbUser?.id) && inv.type === 'DIRECT_INVITE' && (
                              <button
                                disabled={busy}
                                onClick={() => handleRespondInvitation(inv, 'REVOKE')}
                                className="px-2.5 py-1 rounded bg-slate-800 text-red-300 text-[11px] cursor-pointer"
                              >
                                Revoke
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Owner Management Controls & Member Leave Control */}
              {myMember && isPreAuction && lobbyDetails.league.status !== 'CANCELLED' && (
                <div className="pt-5 border-t border-slate-800/80 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    {isHost ? (
                      <div className="flex flex-wrap items-center gap-2.5">
                        <button
                          onClick={() => setEditingSettings((v) => !v)}
                          className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5 cursor-pointer"
                        >
                          <Settings className="w-3.5 h-3.5 text-amber-400" />
                          <span>{editingSettings ? 'Close Settings' : 'Edit League Settings'}</span>
                        </button>

                        {!confirmCancelLeague ? (
                          <button
                            onClick={() => setConfirmCancelLeague(true)}
                            className="px-3.5 py-2 rounded-lg bg-red-950/60 border border-red-800/70 hover:bg-red-900/60 text-xs font-semibold text-red-300 flex items-center gap-1.5 cursor-pointer"
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span>Close / Cancel League</span>
                          </button>
                        ) : (
                          <div className="flex items-center gap-2">
                            <button
                              disabled={busy}
                              onClick={handleCancelLeague}
                              className="px-3 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold cursor-pointer"
                            >
                              Confirm Cancel League
                            </button>
                            <button
                              onClick={() => setConfirmCancelLeague(false)}
                              className="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs cursor-pointer"
                            >
                              Keep Open
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        {!confirmLeaveLeague ? (
                          <button
                            onClick={() => setConfirmLeaveLeague(true)}
                            className="px-3.5 py-2 rounded-lg bg-slate-900 border border-red-900/60 text-xs font-semibold text-red-300 hover:bg-red-950/50 flex items-center gap-1.5 cursor-pointer"
                          >
                            <LogOut className="w-3.5 h-3.5" />
                            <span>Leave League</span>
                          </button>
                        ) : (
                          <>
                            <button
                              disabled={busy}
                              onClick={handleLeaveLeague}
                              className="px-3 py-2 rounded-lg bg-red-600 text-white text-xs font-bold cursor-pointer"
                            >
                              Confirm Leave
                            </button>
                            <button
                              onClick={() => setConfirmLeaveLeague(false)}
                              className="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs cursor-pointer"
                            >
                              Stay
                            </button>
                          </>
                        )}
                      </div>
                    )}

                    <div className="text-[11px] text-slate-500 flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                      <span>{isHost ? 'Owner Controls Active' : 'Member View Only'}</span>
                    </div>
                  </div>

                  {/* Owner Settings Editor Drawer */}
                  {isHost && editingSettings && (
                    <form
                      onSubmit={handleSaveSettings}
                      className="p-4 rounded-xl bg-[#060B18] border border-slate-800 space-y-4"
                    >
                      <div className="text-xs font-semibold text-white">Edit Pre-Auction League Settings</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">League Name</label>
                          <input
                            type="text"
                            required
                            minLength={3}
                            maxLength={60}
                            value={editSettingsForm.name}
                            onChange={(e) =>
                              setEditSettingsForm((f) => ({ ...f, name: e.target.value }))
                            }
                            className="w-full px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">Visibility</label>
                          <select
                            value={editSettingsForm.visibility}
                            onChange={(e) =>
                              setEditSettingsForm((f) => ({
                                ...f,
                                visibility: e.target.value as 'PRIVATE' | 'PUBLIC',
                              }))
                            }
                            className="w-full px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white"
                          >
                            <option value="PRIVATE">Private</option>
                            <option value="PUBLIC">Public</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">Max Capacity</label>
                          <input
                            type="number"
                            min={Math.max(2, lobbyDetails.members.length)}
                            max={12}
                            value={editSettingsForm.maxTeams}
                            onChange={(e) =>
                              setEditSettingsForm((f) => ({
                                ...f,
                                maxTeams: Number(e.target.value),
                                numberOfTeams: Number(e.target.value),
                              }))
                            }
                            className="w-full px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white font-mono-num"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">Starting Purse (L)</label>
                          <input
                            type="number"
                            min={1000}
                            max={100000}
                            step={500}
                            value={editSettingsForm.purseAmount}
                            onChange={(e) =>
                              setEditSettingsForm((f) => ({
                                ...f,
                                purseAmount: Number(e.target.value),
                              }))
                            }
                            className="w-full px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white font-mono-num"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">Min / Max Squad</label>
                          <div className="grid grid-cols-2 gap-1.5">
                            <input
                              type="number"
                              min={11}
                              max={25}
                              value={editSettingsForm.minSquadSize}
                              onChange={(e) =>
                                setEditSettingsForm((f) => ({
                                  ...f,
                                  minSquadSize: Number(e.target.value),
                                }))
                              }
                              className="px-2 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white font-mono-num"
                            />
                            <input
                              type="number"
                              min={editSettingsForm.minSquadSize}
                              max={25}
                              value={editSettingsForm.maxSquadSize}
                              onChange={(e) =>
                                setEditSettingsForm((f) => ({
                                  ...f,
                                  maxSquadSize: Number(e.target.value),
                                }))
                              }
                              className="px-2 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white font-mono-num"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">
                            Bid Inc (L) &amp; Clock (s)
                          </label>
                          <div className="grid grid-cols-2 gap-1.5">
                            <input
                              type="number"
                              min={5}
                              max={500}
                              value={editSettingsForm.bidIncrement}
                              onChange={(e) =>
                                setEditSettingsForm((f) => ({
                                  ...f,
                                  bidIncrement: Number(e.target.value),
                                }))
                              }
                              className="px-2 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white font-mono-num"
                            />
                            <input
                              type="number"
                              min={5}
                              max={60}
                              value={editSettingsForm.timerSeconds}
                              onChange={(e) =>
                                setEditSettingsForm((f) => ({
                                  ...f,
                                  timerSeconds: Number(e.target.value),
                                }))
                              }
                              className="px-2 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white font-mono-num"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 pt-2 border-t border-slate-800/70">
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">Max Overseas</label>
                          <input
                            type="number"
                            min={0}
                            max={12}
                            value={editSettingsForm.maxOverseas}
                            onChange={(e) =>
                              setEditSettingsForm((f) => ({ ...f, maxOverseas: Number(e.target.value) }))
                            }
                            className="w-full px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white font-mono-num"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">Min WK</label>
                          <input
                            type="number"
                            min={0}
                            max={5}
                            value={editSettingsForm.minWicketkeepers}
                            onChange={(e) =>
                              setEditSettingsForm((f) => ({ ...f, minWicketkeepers: Number(e.target.value) }))
                            }
                            className="w-full px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white font-mono-num"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">Min Batsmen</label>
                          <input
                            type="number"
                            min={0}
                            max={10}
                            value={editSettingsForm.minBatsmen}
                            onChange={(e) =>
                              setEditSettingsForm((f) => ({ ...f, minBatsmen: Number(e.target.value) }))
                            }
                            className="w-full px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white font-mono-num"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">Min Bowlers</label>
                          <input
                            type="number"
                            min={0}
                            max={10}
                            value={editSettingsForm.minBowlers}
                            onChange={(e) =>
                              setEditSettingsForm((f) => ({ ...f, minBowlers: Number(e.target.value) }))
                            }
                            className="w-full px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white font-mono-num"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">Min All-Rounders</label>
                          <input
                            type="number"
                            min={0}
                            max={10}
                            value={editSettingsForm.minAllRounders}
                            onChange={(e) =>
                              setEditSettingsForm((f) => ({ ...f, minAllRounders: Number(e.target.value) }))
                            }
                            className="w-full px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-xs text-white font-mono-num"
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editSettingsForm.allowTeamCustomization}
                            onChange={(e) =>
                              setEditSettingsForm((f) => ({
                                ...f,
                                allowTeamCustomization: e.target.checked,
                              }))
                            }
                            className="rounded border-slate-600 bg-[#0B1325]"
                          />
                          <span>Allow member team customization</span>
                        </label>
                        <button
                          type="submit"
                          disabled={busy}
                          className="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold flex items-center gap-1 cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Save Settings</span>
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}

              {/* League Activity Feed */}
              <div className="pt-5 border-t border-slate-800/80 space-y-2.5">
                <h3 className="text-xs font-semibold text-slate-400">Lobby Activity Timeline</h3>
                {lobbyDetails.activity.length === 0 ? (
                  <div className="text-xs text-slate-500">No events recorded yet.</div>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {lobbyDetails.activity.map((act) => (
                      <div key={act.id} className="text-xs flex items-start justify-between gap-3">
                        <span className="text-slate-300">{act.message}</span>
                        <span className="text-[11px] text-slate-500 font-mono-num shrink-0">
                          {new Date(act.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
