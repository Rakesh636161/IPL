import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  FastForward,
  Gavel,
  History,
  Lock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  SkipForward,
  Sparkles,
  Trophy,
  Unlock,
  Users,
  Wifi,
  WifiOff,
  X,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import {
  AuctionDashboardItem,
  AuctionDashboardResponse,
  AuctionSnapshot,
  formatCurrency,
  PlayerOrderMode,
  TeamRecord,
} from '../types/cricketverse.ts';
import { PlayerImage } from './PlayerImage.tsx';
import {
  syncAuctionParticipantPresence,
  syncAuctionSnapshotToFirestore,
} from '../services/auctionFirestoreService.ts';

interface AuctionRoomViewProps {
  leagueId: string | null;
  onSelectLeague: (id: string) => void;
  onOpenTeam: (leagueId: string) => void;
}

type DashboardTab = 'ALL' | 'LIVE' | 'UPCOMING' | 'COMPLETED' | 'JOINABLE' | 'HISTORY';
type RailTab = 'UP_NEXT' | 'RESULTS' | 'AUDIT';

function formatRoleLabel(role: string): string {
  return role.replace(/_/g, ' ');
}

function getStateBadgeClass(state: string): string {
  if (state === 'LIVE' || state === 'BIDDING') {
    return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40';
  }
  if (state === 'PAUSED') {
    return 'bg-amber-500/15 text-amber-400 border-amber-500/40';
  }
  if (state === 'COMPLETED') {
    return 'bg-sky-500/15 text-sky-400 border-sky-500/40';
  }
  if (state === 'CANCELLED') {
    return 'bg-rose-500/15 text-rose-400 border-rose-500/40';
  }
  return 'bg-slate-800 text-slate-300 border-slate-700';
}

function formatBidError(codeOrMessage: string): string {
  if (!codeOrMessage) return 'Bid rejected by auction server.';
  if (codeOrMessage.startsWith('MIN_BID_REQUIRED:')) {
    const val = Number(codeOrMessage.split(':')[1] || 0);
    return `Minimum valid bid is ${formatCurrency(val)} (${val} L).`;
  }
  const map: Record<string, string> = {
    NOT_LEAGUE_MEMBER: 'Only authorized league members can place bids.',
    AUCTION_NOT_ACCEPTING_BIDS: 'Auction is not currently accepting live bids.',
    LOT_TIMER_EXPIRED: 'Lot countdown has expired. Settling current lot.',
    ALREADY_HIGHEST_BIDDER: 'Your franchise already holds the highest bid.',
    PLAYER_ALREADY_OWNED_IN_LEAGUE: 'This player is already owned in this league.',
    SQUAD_LIMIT_REACHED: 'Your franchise has reached its maximum squad capacity.',
    OVERSEAS_LIMIT_REACHED: 'Overseas player cap reached for your franchise.',
    INSUFFICIENT_PURSE: 'Bid exceeds your remaining virtual purse.',
    AUCTION_NOT_FOUND: 'Auction session not found.',
    INVALID_BID_AMOUNT: 'Enter a valid positive integer bid in Lakhs.',
    MAX_TIMER_EXTENSIONS_REACHED: 'Maximum countdown extensions reached for this lot.',
  };
  return map[codeOrMessage] || codeOrMessage;
}

export const AuctionRoomView: React.FC<AuctionRoomViewProps> = ({
  leagueId,
  onSelectLeague,
  onOpenTeam,
}) => {
  const { apiFetch, getIdToken, dbUser } = useAuth();

  // Dashboard state
  const [viewMode, setViewMode] = useState<'dashboard' | 'room'>(leagueId ? 'room' : 'dashboard');
  const [dashboard, setDashboard] = useState<AuctionDashboardResponse | null>(null);
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>('ALL');
  const [dashboardLoading, setDashboardLoading] = useState(true);

  // Create & Join Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: 'Premier Franchise Auction',
    leagueName: 'CricketVerse Premier Series',
    visibility: 'PUBLIC' as 'PUBLIC' | 'PRIVATE',
    maxTeams: 8,
    auctionMode: 'MEGA' as 'MEGA' | 'MINI' | 'FAST_TRACK',
    teamName: '',
    teamShortName: '',
    purseAmount: 10000,
    minSquadSize: 15,
    maxSquadSize: 25,
    maxOverseas: 8,
    minBatsmen: 4,
    minBowlers: 4,
    minAllRounders: 2,
    minWicketkeepers: 1,
    timerSeconds: 20,
    maxTimerExtensions: '',
    useTieredIncrements: true,
    tier1Increment: 5,
    tier2Increment: 10,
    tier3Increment: 25,
    bidIncrement: 10,
    playerOrderMode: 'ADMIN_DEFINED' as PlayerOrderMode,
    playerPoolLimit: '',
    enableSecondRound: true,
    allowSkipPlayer: true,
  });
  const [joinTarget, setJoinTarget] = useState<{ mode: 'code' | 'public'; leagueId?: string; leagueName?: string }>({
    mode: 'code',
  });
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [joinForm, setJoinForm] = useState({ inviteCode: '', teamName: '', teamShortName: '' });

  // Active Room state
  const [snapshot, setSnapshot] = useState<AuctionSnapshot | null>(null);
  const [roomLoading, setRoomLoading] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());
  const [railTab, setRailTab] = useState<RailTab>('UP_NEXT');
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);
  const [customBidInput, setCustomBidInput] = useState('');

  // Config Drawer & Confirmations
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [configForm, setConfigForm] = useState({
    name: '',
    purseAmount: 10000,
    minSquadSize: 15,
    maxSquadSize: 25,
    maxOverseas: 8,
    minBatsmen: 4,
    minBowlers: 4,
    minAllRounders: 2,
    minWicketkeepers: 1,
    timerSeconds: 20,
    maxTimerExtensions: '',
    useTieredIncrements: true,
    tier1Increment: 5,
    tier2Increment: 10,
    tier3Increment: 25,
    bidIncrement: 10,
    playerOrderMode: 'ADMIN_DEFINED' as PlayerOrderMode,
    playerPoolLimit: '',
    enableSecondRound: true,
    allowSkipPlayer: true,
  });
  const [confirmAction, setConfirmAction] = useState<'end' | 'cancel' | null>(null);

  // Notifications & Action Locks
  const [banner, setBanner] = useState<{ type: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const data = await apiFetch<AuctionDashboardResponse>('/api/auctions');
      setDashboard(data);
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load auctions.' });
    } finally {
      setDashboardLoading(false);
    }
  }, [apiFetch]);

  const loadSnapshot = useCallback(
    async (id: string) => {
      setRoomLoading(true);
      try {
        const snap = await apiFetch<AuctionSnapshot>(`/api/auctions/${id}`);
        setSnapshot(snap);
        if (snap.serverNow) {
          setClockOffsetMs(snap.serverNow - Date.now());
        }
      } catch (err) {
        setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load auction room.' });
      } finally {
        setRoomLoading(false);
      }
    },
    [apiFetch]
  );

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (leagueId) {
      setViewMode('room');
      loadSnapshot(leagueId);
    }
  }, [leagueId, loadSnapshot]);

  // Populate config modal form when snapshot refreshes
  useEffect(() => {
    if (!snapshot) return;
    const a = snapshot.auction;
    const l = snapshot.league;
    const s = snapshot.settings;
    setConfigForm({
      name: a.name || `${l.name} Auction`,
      purseAmount: l.purseAmount,
      minSquadSize: l.minSquadSize,
      maxSquadSize: l.maxSquadSize,
      maxOverseas: s?.maxOverseas ?? 8,
      minBatsmen: s?.minBatsmen ?? 4,
      minBowlers: s?.minBowlers ?? 4,
      minAllRounders: s?.minAllRounders ?? 2,
      minWicketkeepers: s?.minWicketkeepers ?? 1,
      timerSeconds: a.timerSeconds ?? l.timerSeconds ?? 20,
      maxTimerExtensions: a.maxTimerExtensions != null ? String(a.maxTimerExtensions) : '',
      useTieredIncrements: a.useTieredIncrements ?? true,
      tier1Increment: a.tier1Increment ?? 5,
      tier2Increment: a.tier2Increment ?? 10,
      tier3Increment: a.tier3Increment ?? 25,
      bidIncrement: l.bidIncrement ?? 10,
      playerOrderMode: a.playerOrderMode ?? 'ADMIN_DEFINED',
      playerPoolLimit: a.playerPoolLimit != null ? String(a.playerPoolLimit) : '',
      enableSecondRound: a.enableSecondRound ?? true,
      allowSkipPlayer: a.allowSkipPlayer ?? true,
    });
  }, [snapshot]);

  // Smooth local countdown ticker synchronized with server clock offset
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // Real-time Socket.IO subscription when viewing a live auction room
  useEffect(() => {
    if (viewMode !== 'room' || !leagueId) return;
    let active = true;
    let socketInstance: Socket | null = null;

    (async () => {
      try {
        const token = await getIdToken();
        if (!active || !token) return;

        socketInstance = io(window.location.origin, {
          auth: { token },
          transports: ['websocket', 'polling'],
        });
        socketRef.current = socketInstance;

        const applySnapshot = (nextSnap: AuctionSnapshot | null | undefined, note?: { type: 'error' | 'success' | 'info'; text: string }) => {
          if (!nextSnap) return;
          setSnapshot(nextSnap);
          if (nextSnap.serverNow) {
            setClockOffsetMs(nextSnap.serverNow - Date.now());
          }
          if (note) setBanner(note);
          if (dbUser?.uid) {
            void syncAuctionSnapshotToFirestore(nextSnap, dbUser.uid);
          }
        };

        socketInstance.on('connect', () => {
          setSocketConnected(true);
          socketInstance?.emit('auction:join', { leagueId }, (ack: { ok?: boolean; snapshot?: AuctionSnapshot; error?: string }) => {
            if (ack?.ok && ack.snapshot) {
              applySnapshot(ack.snapshot);
              if (dbUser?.uid && dbUser?.id) {
                const mine = ack.snapshot.teams.find((t) => t.ownerId === dbUser.id);
                if (mine) {
                  void syncAuctionParticipantPresence({
                    leagueId,
                    leagueOwnerUid: ack.snapshot.league.ownerUid || dbUser.uid,
                    userUid: dbUser.uid,
                    teamId: mine.id,
                    teamName: mine.name,
                    ownerName: mine.ownerName || dbUser.profile?.displayName || 'Owner',
                    connectionStatus: 'CONNECTED',
                  });
                }
              }
            }
          });
        });

        socketInstance.on('disconnect', () => {
          setSocketConnected(false);
        });

        socketInstance.on('auction:stateSync', (snap: AuctionSnapshot) => applySnapshot(snap));
        socketInstance.on('auction:started', (snap: AuctionSnapshot) =>
          applySnapshot(snap, { type: 'success', text: `Auction Round ${snap.auction.roundNumber ?? 1} is now LIVE!` })
        );
        socketInstance.on('auction:player', (snap: AuctionSnapshot) => applySnapshot(snap));
        socketInstance.on('auction:bid', (payload: { snapshot?: AuctionSnapshot; teamShortName?: string; amount?: number }) => {
          if (payload?.snapshot) {
            applySnapshot(payload.snapshot);
          }
        });
        socketInstance.on('auction:bidAccepted', (payload: { snapshot?: AuctionSnapshot; teamName?: string; amount?: number }) => {
          if (payload?.snapshot) {
            applySnapshot(payload.snapshot, {
              type: 'info',
              text: `${payload.teamName || 'Team'} leads at ${formatCurrency(payload.amount || 0)}`,
            });
          }
        });
        socketInstance.on('auction:bidRejected', (payload: { error?: string }) => {
          setBanner({ type: 'error', text: formatBidError(payload?.error || 'BID_REJECTED') });
        });
        socketInstance.on('auction:timer', (payload: { serverNow: number; lotDeadlineAt: string }) => {
          if (payload?.serverNow) {
            setClockOffsetMs(payload.serverNow - Date.now());
          }
          setSnapshot((prev) =>
            prev
              ? {
                  ...prev,
                  auction: {
                    ...prev.auction,
                    lotDeadlineAt: payload.lotDeadlineAt,
                  },
                }
              : prev
          );
        });
        socketInstance.on('auction:sold', (payload: { player?: { name: string }; team?: { name: string }; finalPrice?: number; snapshot?: AuctionSnapshot }) => {
          if (payload?.snapshot) {
            applySnapshot(payload.snapshot, {
              type: 'success',
              text: `SOLD! ${payload.player?.name || 'Player'} acquired by ${payload.team?.name || 'Team'} for ${formatCurrency(payload.finalPrice || 0)}`,
            });
          }
        });
        socketInstance.on('auction:unsold', (payload: { player?: { name: string }; skipped?: boolean; snapshot?: AuctionSnapshot }) => {
          if (payload?.snapshot) {
            applySnapshot(payload.snapshot, {
              type: 'info',
              text: `${payload.player?.name || 'Player'} went ${payload.skipped ? 'SKIPPED / UNSOLD' : 'UNSOLD'}.`,
            });
          }
        });
        socketInstance.on('auction:paused', (snap: AuctionSnapshot) =>
          applySnapshot(snap, { type: 'info', text: 'Auction paused by league host.' })
        );
        socketInstance.on('auction:resumed', (snap: AuctionSnapshot) =>
          applySnapshot(snap, { type: 'success', text: 'Auction resumed!' })
        );
        socketInstance.on('auction:completed', (snap: AuctionSnapshot) =>
          applySnapshot(snap, { type: 'success', text: 'Auction round completed. Check final squads and standings.' })
        );
        socketInstance.on('auction:cancelled', (snap: AuctionSnapshot) =>
          applySnapshot(snap, { type: 'error', text: 'Auction was cancelled by league host.' })
        );
      } catch {
        setSocketConnected(false);
      }
    })();

    return () => {
      active = false;
      if (socketInstance) {
        socketInstance.disconnect();
      }
      socketRef.current = null;
    };
  }, [viewMode, leagueId, getIdToken, dbUser?.uid, dbUser?.id, dbUser?.profile?.displayName]);

  const enterRoom = (targetLeagueId: string) => {
    setBanner(null);
    onSelectLeague(targetLeagueId);
    setViewMode('room');
    void loadSnapshot(targetLeagueId);
  };

  const backToDashboard = () => {
    setBanner(null);
    setViewMode('dashboard');
    void loadDashboard();
  };

  const emitSocketOrRest = async (
    socketEvent: string,
    payload: Record<string, unknown>,
    restFallback: () => Promise<AuctionSnapshot>
  ): Promise<AuctionSnapshot | null> => {
    if (socketRef.current && socketRef.current.connected) {
      return new Promise((resolve, reject) => {
        socketRef.current!.emit(
          socketEvent,
          payload,
          (ack: { ok?: boolean; snapshot?: AuctionSnapshot; error?: string }) => {
            if (ack?.ok) {
              if (ack.snapshot) setSnapshot(ack.snapshot);
              resolve(ack.snapshot ?? null);
            } else {
              reject(new Error(ack?.error || 'SOCKET_ACTION_FAILED'));
            }
          }
        );
      });
    }
    const resSnap = await restFallback();
    setSnapshot(resSnap);
    return resSnap;
  };

  // Dashboard Actions
  const handleCreateAuction = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionBusy(true);
    setBanner(null);
    try {
      const createdSnap = await apiFetch<AuctionSnapshot>('/api/auctions', {
        method: 'POST',
        body: JSON.stringify({
          name: createForm.name.trim(),
          leagueName: createForm.leagueName.trim(),
          visibility: createForm.visibility,
          maxTeams: Number(createForm.maxTeams),
          auctionMode: createForm.auctionMode,
          teamName: createForm.teamName.trim() || `${dbUser?.profile?.displayName || 'Host'} XI`,
          teamShortName: (createForm.teamShortName.trim() || 'HST').toUpperCase().slice(0, 4),
          purseAmount: Number(createForm.purseAmount),
          minSquadSize: Number(createForm.minSquadSize),
          maxSquadSize: Number(createForm.maxSquadSize),
          maxOverseas: Number(createForm.maxOverseas),
          minBatsmen: Number(createForm.minBatsmen),
          minBowlers: Number(createForm.minBowlers),
          minAllRounders: Number(createForm.minAllRounders),
          minWicketkeepers: Number(createForm.minWicketkeepers),
          timerSeconds: Number(createForm.timerSeconds),
          maxTimerExtensions: createForm.maxTimerExtensions ? Number(createForm.maxTimerExtensions) : null,
          useTieredIncrements: createForm.useTieredIncrements,
          tier1Increment: Number(createForm.tier1Increment),
          tier2Increment: Number(createForm.tier2Increment),
          tier3Increment: Number(createForm.tier3Increment),
          bidIncrement: Number(createForm.bidIncrement),
          playerOrderMode: createForm.playerOrderMode,
          playerPoolLimit: createForm.playerPoolLimit ? Number(createForm.playerPoolLimit) : null,
          enableSecondRound: createForm.enableSecondRound,
          allowSkipPlayer: createForm.allowSkipPlayer,
        }),
      });
      setShowCreateModal(false);
      await loadDashboard();
      if (createdSnap?.league?.id) {
        enterRoom(createdSnap.league.id);
      }
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Failed to create auction.' });
    } finally {
      setActionBusy(false);
    }
  };

  const handleJoinAuction = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionBusy(true);
    setBanner(null);
    try {
      let joinedLeagueId = joinTarget.leagueId || '';
      if (joinTarget.mode === 'code') {
        const res = await apiFetch<{ league: { id: string } }>('/api/leagues/join', {
          method: 'POST',
          body: JSON.stringify({
            inviteCode: joinForm.inviteCode.trim().toUpperCase(),
            teamName: joinForm.teamName.trim(),
            teamShortName: joinForm.teamShortName.trim().toUpperCase().slice(0, 4),
          }),
        });
        joinedLeagueId = res.league.id;
      } else if (joinTarget.leagueId) {
        const res = await apiFetch<{ league: { id: string } }>(`/api/leagues/${joinTarget.leagueId}/join-public`, {
          method: 'POST',
          body: JSON.stringify({
            teamName: joinForm.teamName.trim(),
            teamShortName: joinForm.teamShortName.trim().toUpperCase().slice(0, 4),
          }),
        });
        joinedLeagueId = res.league.id;
      }
      setShowJoinModal(false);
      setJoinForm({ inviteCode: '', teamName: '', teamShortName: '' });
      await loadDashboard();
      if (joinedLeagueId) enterRoom(joinedLeagueId);
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Failed to join auction.' });
    } finally {
      setActionBusy(false);
    }
  };

  // Room Configuration Save
  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leagueId) return;
    setActionBusy(true);
    setBanner(null);
    try {
      const updated = await apiFetch<AuctionSnapshot>(`/api/auctions/${leagueId}/config`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: configForm.name.trim(),
          purseAmount: Number(configForm.purseAmount),
          minSquadSize: Number(configForm.minSquadSize),
          maxSquadSize: Number(configForm.maxSquadSize),
          maxOverseas: Number(configForm.maxOverseas),
          minBatsmen: Number(configForm.minBatsmen),
          minBowlers: Number(configForm.minBowlers),
          minAllRounders: Number(configForm.minAllRounders),
          minWicketkeepers: Number(configForm.minWicketkeepers),
          timerSeconds: Number(configForm.timerSeconds),
          maxTimerExtensions: configForm.maxTimerExtensions ? Number(configForm.maxTimerExtensions) : null,
          useTieredIncrements: configForm.useTieredIncrements,
          tier1Increment: Number(configForm.tier1Increment),
          tier2Increment: Number(configForm.tier2Increment),
          tier3Increment: Number(configForm.tier3Increment),
          bidIncrement: Number(configForm.bidIncrement),
          playerOrderMode: configForm.playerOrderMode,
          playerPoolLimit: configForm.playerPoolLimit ? Number(configForm.playerPoolLimit) : null,
          enableSecondRound: configForm.enableSecondRound,
          allowSkipPlayer: configForm.allowSkipPlayer,
        }),
      });
      setSnapshot(updated);
      setShowConfigModal(false);
      setBanner({ type: 'success', text: 'Auction rules & configuration saved.' });
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save configuration.' });
    } finally {
      setActionBusy(false);
    }
  };

  // Bidding & Host Controls
  const placeBidAmount = async (amount: number) => {
    if (!leagueId || !snapshot) return;
    setActionBusy(true);
    setBanner(null);
    const idempotencyKey = `bid-${dbUser?.id || 'u'}-${snapshot.auction.currentLotId || 'lot'}-${amount}-${Date.now()}`;
    try {
      await emitSocketOrRest(
        'auction:bid',
        { leagueId, amount, idempotencyKey },
        async () => {
          const res = await apiFetch<{ snapshot: AuctionSnapshot }>(`/api/auctions/${leagueId}/bid`, {
            method: 'POST',
            body: JSON.stringify({ amount, idempotencyKey }),
          });
          return res.snapshot;
        }
      );
      setCustomBidInput('');
    } catch (err) {
      setBanner({ type: 'error', text: formatBidError(err instanceof Error ? err.message : 'BID_REJECTED') });
    } finally {
      setActionBusy(false);
    }
  };

  const runHostControl = async (
    type: 'start' | 'pause' | 'resume' | 'nextLot' | 'skip' | 'unsoldRound' | 'end' | 'cancel'
  ) => {
    if (!leagueId) return;
    setActionBusy(true);
    setBanner(null);
    setConfirmAction(null);
    try {
      const eventMap: Record<typeof type, string> = {
        start: 'auction:start',
        pause: 'auction:pause',
        resume: 'auction:resume',
        nextLot: 'auction:nextLot',
        skip: 'auction:skip',
        unsoldRound: 'auction:unsoldRound',
        end: 'auction:end',
        cancel: 'auction:cancel',
      };
      const pathMap: Record<typeof type, string> = {
        start: `/api/auctions/${leagueId}/start`,
        pause: `/api/auctions/${leagueId}/pause`,
        resume: `/api/auctions/${leagueId}/resume`,
        nextLot: `/api/auctions/${leagueId}/finalize-lot`,
        skip: `/api/auctions/${leagueId}/skip`,
        unsoldRound: `/api/auctions/${leagueId}/unsold-round`,
        end: `/api/auctions/${leagueId}/end`,
        cancel: `/api/auctions/${leagueId}/cancel`,
      };
      await emitSocketOrRest(
        eventMap[type],
        type === 'end' ? { leagueId, force: true } : { leagueId },
        () => apiFetch<AuctionSnapshot>(pathMap[type], { method: 'POST', body: JSON.stringify(type === 'end' ? { force: true } : {}) })
      );
    } catch (err) {
      setBanner({ type: 'error', text: err instanceof Error ? err.message : 'Action failed.' });
    } finally {
      setActionBusy(false);
    }
  };

  // Derived Room Values
  const myTeam: TeamRecord | undefined = useMemo(
    () => snapshot?.teams.find((t) => t.ownerId === dbUser?.id),
    [snapshot?.teams, dbUser?.id]
  );

  const isHost = Boolean(
    snapshot && (snapshot.league.ownerId === dbUser?.id || dbUser?.role === 'ADMIN')
  );

  const auction = snapshot?.auction;
  const currentLot = snapshot?.currentLot;
  const currentPlayer = snapshot?.currentPlayer;
  const maxOverseasLimit = snapshot?.settings?.maxOverseas ?? 8;
  const timerSecondsTotal = auction?.timerSeconds ?? snapshot?.league.timerSeconds ?? 20;

  const remainingMs = useMemo(() => {
    if (!auction) return 0;
    if (auction.state === 'PAUSED') return auction.pausedRemainingMs ?? timerSecondsTotal * 1000;
    if (!auction.lotDeadlineAt) return 0;
    const deadlineMs = new Date(auction.lotDeadlineAt).getTime();
    return Math.max(0, deadlineMs - (nowMs + clockOffsetMs));
  }, [auction, nowMs, clockOffsetMs, timerSecondsTotal]);

  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const timerProgressPct = Math.min(100, Math.max(0, (remainingMs / (timerSecondsTotal * 1000)) * 100));

  const nextIncrement = useMemo(() => {
    if (!auction || !currentLot) return 10;
    if (auction.nextIncrement) return auction.nextIncrement;
    const refAmount = auction.currentBid ?? currentLot.basePrice;
    if (auction.useTieredIncrements === false) {
      return snapshot?.league.bidIncrement ?? 25;
    }
    if (refAmount < 100) return auction.tier1Increment ?? 5;
    if (refAmount <= 500) return auction.tier2Increment ?? 10;
    return auction.tier3Increment ?? 25;
  }, [auction, currentLot, snapshot?.league.bidIncrement]);

  const minimumNextBid = useMemo(() => {
    if (!auction || !currentLot) return 0;
    if (auction.currentBid === null) return currentLot.basePrice;
    return auction.currentBid + nextIncrement;
  }, [auction, currentLot, nextIncrement]);

  const holdingTeam = useMemo(
    () => snapshot?.teams.find((t) => t.id === auction?.highestBidderTeamId),
    [snapshot?.teams, auction?.highestBidderTeamId]
  );

  const bidGuardReason = useMemo(() => {
    if (!auction || !currentLot || !currentPlayer) return 'No active lot.';
    if (auction.state !== 'LIVE' && auction.state !== 'BIDDING') return 'Auction is not live.';
    if (!myTeam) return 'You do not own a participating team in this league.';
    if (auction.highestBidderTeamId === myTeam.id) return 'You already hold the highest bid.';
    if ((myTeam.availableSlots ?? 0) <= 0 || myTeam.squadCount >= (snapshot?.league.maxSquadSize ?? 25)) {
      return 'Maximum squad limit reached.';
    }
    if (currentPlayer.isOverseas && (myTeam.overseasCount ?? 0) >= maxOverseasLimit) {
      return `Overseas player cap (${maxOverseasLimit}) reached.`;
    }
    if (myTeam.remainingPurse < minimumNextBid) {
      return `Insufficient purse (${formatCurrency(myTeam.remainingPurse)} remaining).`;
    }
    return null;
  }, [auction, currentLot, currentPlayer, myTeam, snapshot?.league.maxSquadSize, maxOverseasLimit, minimumNextBid]);

  const filteredDashboardItems: AuctionDashboardItem[] = useMemo(() => {
    if (!dashboard) return [];
    if (dashboardTab === 'LIVE') return Array.isArray(dashboard.live) ? dashboard.live : [];
    if (dashboardTab === 'UPCOMING') return Array.isArray(dashboard.upcoming) ? dashboard.upcoming : [];
    if (dashboardTab === 'COMPLETED') return Array.isArray(dashboard.completed) ? dashboard.completed : [];
    if (dashboardTab === 'JOINABLE') return Array.isArray(dashboard.joinable) ? dashboard.joinable : [];
    return Array.isArray(dashboard.auctions) ? dashboard.auctions : [];
  }, [dashboard, dashboardTab]);

  // =========================================================================
  // RENDER: AUCTION DASHBOARD
  // =========================================================================
  if (viewMode === 'dashboard' || !leagueId) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">
              Real-Time Multiplayer Arena
            </p>
            <h1 className="text-2xl sm:text-3xl font-display font-bold text-white mt-1">
              Auction Command Dashboard
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Create, configure, join, and monitor synchronized franchise auctions across all your leagues.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              onClick={() => {
                setJoinTarget({ mode: 'code' });
                setShowJoinModal(true);
              }}
              className="px-4 py-2.5 rounded-lg bg-[#0B1325] hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold cursor-pointer"
            >
              Join via Invite Code
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Create Auction
            </button>
            <button
              onClick={() => void loadDashboard()}
              className="p-2.5 rounded-lg bg-[#0B1325] border border-slate-800 text-slate-300 hover:text-white cursor-pointer"
              title="Refresh Auctions"
            >
              <RefreshCw className={`w-4 h-4 ${dashboardLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {banner && (
          <div
            className={`px-4 py-3 rounded-lg border text-sm flex items-center justify-between gap-3 ${
              banner.type === 'error'
                ? 'bg-rose-500/10 border-rose-500/40 text-rose-300'
                : banner.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                : 'bg-sky-500/10 border-sky-500/40 text-sky-300'
            }`}
          >
            <span>{banner.text}</span>
            <button onClick={() => setBanner(null)} className="text-xs opacity-80 hover:opacity-100 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* KPI Row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: 'Live Auctions', value: dashboard?.live?.length ?? 0, accent: 'text-emerald-400' },
            { label: 'Upcoming Auctions', value: dashboard?.upcoming?.length ?? 0, accent: 'text-amber-400' },
            { label: 'Open to Join', value: dashboard?.joinable?.length ?? 0, accent: 'text-sky-400' },
            { label: 'Completed Rooms', value: dashboard?.completed?.length ?? 0, accent: 'text-slate-200' },
          ].map((stat) => (
            <div key={stat.label} className="bg-[#0B1325] border border-slate-800 rounded-xl p-4">
              <p className="text-xs text-slate-400 font-medium">{stat.label}</p>
              <p className={`text-2xl font-display font-bold font-mono-num mt-1 ${stat.accent}`}>
                {stat.value}
              </p>
            </div>
          ))}
        </div>

        {/* Navigation Tabs */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
          {(
            [
              { id: 'ALL', label: `All (${dashboard?.auctions?.length ?? 0})` },
              { id: 'LIVE', label: `Live (${dashboard?.live?.length ?? 0})` },
              { id: 'UPCOMING', label: `Upcoming (${dashboard?.upcoming?.length ?? 0})` },
              { id: 'JOINABLE', label: `Join Auction (${dashboard?.joinable?.length ?? 0})` },
              { id: 'COMPLETED', label: `Completed (${dashboard?.completed?.length ?? 0})` },
              { id: 'HISTORY', label: 'Auction History' },
            ] as Array<{ id: DashboardTab; label: string }>
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setDashboardTab(t.id)}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                dashboardTab === t.id
                  ? 'bg-amber-500 text-slate-950'
                  : 'bg-[#0B1325] text-slate-300 border border-slate-800 hover:border-slate-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {dashboardTab === 'HISTORY' ? (
          <div className="space-y-4">
            {(!dashboard?.history || dashboard.history.length === 0) ? (
              <div className="bg-[#0B1325] border border-slate-800 rounded-xl p-8 text-center text-sm text-slate-400">
                No completed auction history yet. Finish an auction room to view full sold & unsold records.
              </div>
            ) : (
              dashboard.history.map((item) => (
                <div key={item.auctionId} className="bg-[#0B1325] border border-slate-800 rounded-xl p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2.5">
                        <h3 className="text-lg font-display font-bold text-white">{item.auctionName}</h3>
                        <span className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${getStateBadgeClass(item.auctionState)}`}>
                          {item.auctionState}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">
                        League: <span className="text-slate-200 font-medium">{item.leagueName}</span> · ID:{' '}
                        <span className="font-mono-num text-slate-300">{item.leagueId.slice(0, 8)}</span> ·{' '}
                        {item.participatingTeamsCount} Teams · {item.soldPlayersCount} Sold / {item.unsoldPlayersCount} Unsold
                      </p>
                    </div>
                    <button
                      onClick={() => enterRoom(item.leagueId)}
                      className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold cursor-pointer"
                    >
                      Inspect Room & Ledger
                    </button>
                  </div>

                  {item.results.length > 0 && (
                    <div className="overflow-x-auto border border-slate-800 rounded-lg">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-[#060B18] text-slate-400">
                          <tr>
                            <th className="px-3 py-2 font-medium">Player</th>
                            <th className="px-3 py-2 font-medium">Role</th>
                            <th className="px-3 py-2 font-medium">Outcome</th>
                            <th className="px-3 py-2 font-medium">Winning Team</th>
                            <th className="px-3 py-2 font-medium text-right">Final Price</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/70">
                          {item.results.slice(0, 8).map((r) => (
                            <tr key={r.id}>
                              <td className="px-3 py-2 font-medium text-white">{r.playerName}</td>
                              <td className="px-3 py-2 text-slate-400">{formatRoleLabel(r.playerRole)}</td>
                              <td className="px-3 py-2">
                                <span className={r.status === 'SOLD' ? 'text-emerald-400 font-semibold' : 'text-slate-400'}>
                                  {r.status}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-slate-200">{r.winningTeamName || '—'}</td>
                              <td className="px-3 py-2 text-right font-mono-num text-amber-400 font-semibold">
                                {r.status === 'SOLD' ? formatCurrency(r.finalPrice) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filteredDashboardItems.length === 0 ? (
              <div className="lg:col-span-2 bg-[#0B1325] border border-slate-800 rounded-xl p-10 text-center space-y-3">
                <Gavel className="w-10 h-10 text-amber-400 mx-auto" />
                <h3 className="text-base font-display font-semibold text-white">No auctions in this view</h3>
                <p className="text-xs text-slate-400 max-w-md mx-auto">
                  Create a new multiplayer auction room or join an open league using an invitation code.
                </p>
              </div>
            ) : (
              filteredDashboardItems.map((item) => (
                <div
                  key={item.auctionId}
                  className="bg-[#0B1325] border border-slate-800 rounded-xl p-5 flex flex-col justify-between gap-4"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-lg font-display font-bold text-white">{item.auctionName}</h3>
                          <span
                            className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${getStateBadgeClass(item.auctionState)}`}
                          >
                            {item.auctionState}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 mt-1">
                          League: <span className="text-slate-200 font-medium">{item.leagueName}</span> · ID:{' '}
                          <span className="font-mono-num text-slate-300">{item.leagueId.slice(0, 8)}</span> · Invite:{' '}
                          <span className="font-mono-num text-amber-400">{item.inviteCode}</span>
                        </p>
                      </div>
                      {item.settingsLocked ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 shrink-0">
                          <Lock className="w-3.5 h-3.5" /> Locked
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 shrink-0">
                          <Unlock className="w-3.5 h-3.5" /> Configurable
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-4 gap-2 bg-[#060B18] border border-slate-800/80 rounded-lg p-3 text-xs">
                      <div>
                        <p className="text-slate-400">Teams</p>
                        <p className="font-mono-num font-bold text-white mt-0.5">
                          {item.participatingTeamsCount} / {item.maxTeams}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400">Players Pool</p>
                        <p className="font-mono-num font-bold text-white mt-0.5">{item.totalPlayersAvailable}</p>
                      </div>
                      <div>
                        <p className="text-slate-400">Purse Cap</p>
                        <p className="font-mono-num font-bold text-amber-400 mt-0.5">
                          {formatCurrency(item.config.purseAmount)}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-400">Clock</p>
                        <p className="font-mono-num font-bold text-slate-200 mt-0.5">{item.config.timerSeconds}s</p>
                      </div>
                    </div>

                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1.5">
                        Participating Owners ({item.participatingOwners.length})
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {item.participatingOwners.map((o) => (
                          <span
                            key={o.userId}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#060B18] border border-slate-800 text-xs text-slate-200"
                          >
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: o.primaryColor || '#F59E0B' }}
                            />
                            <span className="font-semibold text-white">{o.teamShortName}</span>
                            <span className="text-slate-400">· {o.displayName}</span>
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="text-xs text-slate-400 flex items-center gap-2">
                      <CalendarClock className="w-3.5 h-3.5 text-slate-500" />
                      <span>
                        {item.startedAt
                          ? `Started ${new Date(item.startedAt).toLocaleString()}`
                          : item.scheduledStartAt
                          ? `Scheduled ${new Date(item.scheduledStartAt).toLocaleString()}`
                          : 'Ready to start once host launches'}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-800/80">
                    <div className="text-xs text-slate-400">
                      Order: <span className="text-slate-200 font-medium">{item.config.playerOrderMode}</span> ·{' '}
                      {item.config.useTieredIncrements ? 'Tiered 5L/10L/25L' : `Flat ${item.config.bidIncrement}L`}
                    </div>
                    <div className="flex items-center gap-2">
                      {item.isMember ? (
                        <>
                          <button
                            onClick={() => onOpenTeam(item.leagueId)}
                            className="px-3 py-2 rounded-lg bg-[#060B18] hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold cursor-pointer"
                          >
                            My Squad
                          </button>
                          <button
                            onClick={() => enterRoom(item.leagueId)}
                            className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
                          >
                            Enter Auction Room
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => {
                            setJoinTarget({ mode: 'public', leagueId: item.leagueId, leagueName: item.leagueName });
                            setShowJoinModal(true);
                          }}
                          className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold cursor-pointer"
                        >
                          Join Auction
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* CREATE AUCTION MODAL */}
        {showCreateModal && (
          <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
            <form
              onSubmit={handleCreateAuction}
              className="bg-[#0B1325] border border-slate-700 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 space-y-5"
            >
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                  <h2 className="text-lg font-display font-bold text-white">Create Multiplayer Auction</h2>
                  <p className="text-xs text-slate-400">Configure league room, purse, squad rules, and bidding increments.</p>
                </div>
                <button type="button" onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Auction Title</span>
                  <input
                    required
                    value={createForm.name}
                    onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">League Name</span>
                  <input
                    required
                    value={createForm.leagueName}
                    onChange={(e) => setCreateForm((f) => ({ ...f, leagueName: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Your Franchise Name</span>
                  <input
                    required
                    placeholder="e.g. Royal Challengers Arena"
                    value={createForm.teamName}
                    onChange={(e) => setCreateForm((f) => ({ ...f, teamName: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Team Short Tag (2–4 chars)</span>
                  <input
                    required
                    maxLength={4}
                    placeholder="RCA"
                    value={createForm.teamShortName}
                    onChange={(e) => setCreateForm((f) => ({ ...f, teamShortName: e.target.value.toUpperCase() }))}
                    className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white uppercase"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Visibility</span>
                  <select
                    value={createForm.visibility}
                    onChange={(e) => setCreateForm((f) => ({ ...f, visibility: e.target.value as 'PUBLIC' | 'PRIVATE' }))}
                    className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white"
                  >
                    <option value="PUBLIC">PUBLIC (Open Lobby)</option>
                    <option value="PRIVATE">PRIVATE (Invite Code Only)</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Max Teams (2–12)</span>
                  <input
                    type="number"
                    min={2}
                    max={12}
                    value={createForm.maxTeams}
                    onChange={(e) => setCreateForm((f) => ({ ...f, maxTeams: Number(e.target.value) }))}
                    className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Starting Purse (Lakhs, 10000 = 100 Cr)</span>
                  <input
                    type="number"
                    min={500}
                    max={100000}
                    value={createForm.purseAmount}
                    onChange={(e) => setCreateForm((f) => ({ ...f, purseAmount: Number(e.target.value) }))}
                    className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Countdown Timer (Seconds)</span>
                  <input
                    type="number"
                    min={5}
                    max={120}
                    value={createForm.timerSeconds}
                    onChange={(e) => setCreateForm((f) => ({ ...f, timerSeconds: Number(e.target.value) }))}
                    className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Min / Max Squad Size</span>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      min={1}
                      max={25}
                      value={createForm.minSquadSize}
                      onChange={(e) => setCreateForm((f) => ({ ...f, minSquadSize: Number(e.target.value) }))}
                      className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                    />
                    <input
                      type="number"
                      min={1}
                      max={25}
                      value={createForm.maxSquadSize}
                      onChange={(e) => setCreateForm((f) => ({ ...f, maxSquadSize: Number(e.target.value) }))}
                      className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                    />
                  </div>
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Max Overseas / Max Timer Extensions</span>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      min={0}
                      max={12}
                      value={createForm.maxOverseas}
                      onChange={(e) => setCreateForm((f) => ({ ...f, maxOverseas: Number(e.target.value) }))}
                      className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                    />
                    <input
                      type="number"
                      min={0}
                      max={100}
                      placeholder="Unlimited"
                      value={createForm.maxTimerExtensions}
                      onChange={(e) => setCreateForm((f) => ({ ...f, maxTimerExtensions: e.target.value }))}
                      className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                    />
                  </div>
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Player Auction Order</span>
                  <select
                    value={createForm.playerOrderMode}
                    onChange={(e) => setCreateForm((f) => ({ ...f, playerOrderMode: e.target.value as PlayerOrderMode }))}
                    className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white"
                  >
                    <option value="ADMIN_DEFINED">Tiered Marquee / Caps / Domestic</option>
                    <option value="ROLE_BASED">Role Based (Bat → WK → AR → Bowl)</option>
                    <option value="RANDOM">Randomized Pool</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="text-slate-300 font-medium">Player Pool Cap (Optional)</span>
                  <input
                    type="number"
                    min={1}
                    max={300}
                    placeholder="All eligible (128)"
                    value={createForm.playerPoolLimit}
                    onChange={(e) => setCreateForm((f) => ({ ...f, playerPoolLimit: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                  />
                </label>
              </div>

              <div className="bg-[#060B18] border border-slate-800 rounded-xl p-4 space-y-3 text-xs">
                <label className="flex items-center gap-2 text-white font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createForm.useTieredIncrements}
                    onChange={(e) => setCreateForm((f) => ({ ...f, useTieredIncrements: e.target.checked }))}
                  />
                  Use Tiered Bid Increments (Default: &lt;1 Cr: 5L, 1–5 Cr: 10L, &gt;5 Cr: 25L)
                </label>
                <div className="flex flex-wrap gap-6">
                  <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={createForm.enableSecondRound}
                      onChange={(e) => setCreateForm((f) => ({ ...f, enableSecondRound: e.target.checked }))}
                    />
                    Enable Unsold Round 2 Re-auction
                  </label>
                  <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={createForm.allowSkipPlayer}
                      onChange={(e) => setCreateForm((f) => ({ ...f, allowSkipPlayer: e.target.checked }))}
                    />
                    Allow Host to Skip Unbid Players
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-2.5 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionBusy}
                  className="px-5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer disabled:opacity-50"
                >
                  {actionBusy ? 'Creating...' : 'Create & Open Room'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* JOIN AUCTION MODAL */}
        {showJoinModal && (
          <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
            <form
              onSubmit={handleJoinAuction}
              className="bg-[#0B1325] border border-slate-700 rounded-2xl max-w-md w-full p-6 space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h2 className="text-lg font-display font-bold text-white">
                  {joinTarget.mode === 'code' ? 'Join Auction via Code' : `Join ${joinTarget.leagueName}`}
                </h2>
                <button type="button" onClick={() => setShowJoinModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                  <X className="w-5 h-5" />
                </button>
              </div>
              {joinTarget.mode === 'code' && (
                <label className="block space-y-1 text-xs">
                  <span className="text-slate-300 font-medium">League Invite Code</span>
                  <input
                    required
                    placeholder="e.g. CV8X2K"
                    value={joinForm.inviteCode}
                    onChange={(e) => setJoinForm((f) => ({ ...f, inviteCode: e.target.value.toUpperCase() }))}
                    className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num uppercase"
                  />
                </label>
              )}
              <label className="block space-y-1 text-xs">
                <span className="text-slate-300 font-medium">Franchise Team Name</span>
                <input
                  required
                  placeholder="Mumbai Mavericks"
                  value={joinForm.teamName}
                  onChange={(e) => setJoinForm((f) => ({ ...f, teamName: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white"
                />
              </label>
              <label className="block space-y-1 text-xs">
                <span className="text-slate-300 font-medium">Short Tag (2–4 chars)</span>
                <input
                  required
                  maxLength={4}
                  placeholder="MMAV"
                  value={joinForm.teamShortName}
                  onChange={(e) => setJoinForm((f) => ({ ...f, teamShortName: e.target.value.toUpperCase() }))}
                  className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white uppercase"
                />
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowJoinModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionBusy}
                  className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold cursor-pointer disabled:opacity-50"
                >
                  {actionBusy ? 'Joining...' : 'Join Franchise'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    );
  }

  // =========================================================================
  // RENDER: LIVE AUCTION ROOM
  // =========================================================================
  return (
    <div className="space-y-5">
      {/* Top Broadcast Header */}
      <div className="bg-[#0B1325] border border-slate-800 rounded-xl px-4 py-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={backToDashboard}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#060B18] hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-200 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Dashboard
          </button>

          {dashboard && Array.isArray(dashboard.auctions) && dashboard.auctions.length > 0 && (
            <select
              value={leagueId}
              onChange={(e) => enterRoom(e.target.value)}
              className="px-3 py-1.5 rounded-lg bg-[#060B18] border border-slate-700 text-xs font-semibold text-white"
            >
              {dashboard.auctions.map((a) => (
                <option key={a.leagueId} value={a.leagueId}>
                  {a.auctionName} ({a.auctionState})
                </option>
              ))}
            </select>
          )}

          {auction && (
            <span className={`px-2.5 py-1 rounded border text-xs font-bold ${getStateBadgeClass(auction.state)}`}>
              {auction.state}
            </span>
          )}

          {auction && (
            <span className="text-xs font-mono-num text-slate-300">
              Round {auction.roundNumber ?? 1} · Lot {auction.lotOrder} / {auction.totalLots || '—'}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium ${
              socketConnected
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
            }`}
          >
            {socketConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {socketConnected ? 'Real-Time Synced' : 'Connecting...'}
          </span>

          {isHost && (
            <button
              onClick={() => setShowConfigModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#060B18] hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-200 cursor-pointer"
            >
              {auction?.settingsLocked ? <Lock className="w-3.5 h-3.5 text-slate-400" /> : <Settings className="w-3.5 h-3.5 text-amber-400" />}
              {auction?.settingsLocked ? 'View Locked Rules' : 'Configure Auction'}
            </button>
          )}

          <button
            onClick={() => void loadSnapshot(leagueId)}
            className="p-2 rounded-lg bg-[#060B18] border border-slate-700 text-slate-300 hover:text-white cursor-pointer"
            title="Resync State"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${roomLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {banner && (
        <div
          className={`px-4 py-3 rounded-lg border text-sm flex items-center justify-between gap-3 ${
            banner.type === 'error'
              ? 'bg-rose-500/10 border-rose-500/40 text-rose-300'
              : banner.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
              : 'bg-sky-500/10 border-sky-500/40 text-sky-300'
          }`}
        >
          <span>{banner.text}</span>
          <button onClick={() => setBanner(null)} className="text-xs opacity-80 hover:opacity-100 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {!snapshot ? (
        <div className="bg-[#0B1325] border border-slate-800 rounded-xl p-12 text-center text-slate-400 text-sm">
          Loading authoritative auction state...
        </div>
      ) : (
        <>
          {/* Pre-Start Waiting / Post-Auction Summary Banner */}
          {(auction?.state === 'WAITING' || auction?.state === 'CREATED') && (
            <div className="bg-[#0B1325] border border-amber-500/30 rounded-xl p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="space-y-1.5">
                <h2 className="text-xl font-display font-bold text-white">
                  {auction.name || `${snapshot.league.name} Auction`} — Pre-Auction Lobby
                </h2>
                <p className="text-xs text-slate-400">
                  {snapshot.teams.length} franchise{snapshot.teams.length === 1 ? '' : 's'} joined · Purse{' '}
                  <span className="font-mono-num text-amber-400">{formatCurrency(snapshot.league.purseAmount)}</span> ·
                  Squad <span className="font-mono-num">{snapshot.league.minSquadSize}–{snapshot.league.maxSquadSize}</span> ·
                  Max Overseas <span className="font-mono-num">{maxOverseasLimit}</span> · Clock{' '}
                  <span className="font-mono-num">{timerSecondsTotal}s</span>
                </p>
                {snapshot.teams.length < 2 && (
                  <p className="text-xs text-amber-300 font-medium">
                    Invite Code: <span className="font-mono-num font-bold">{snapshot.league.inviteCode}</span> — At least 2 franchises must join before starting.
                  </p>
                )}
              </div>
              {isHost && (
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    onClick={() => setShowConfigModal(true)}
                    className="px-4 py-2.5 rounded-lg bg-[#060B18] hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-200 cursor-pointer"
                  >
                    Configure Rules
                  </button>
                  <button
                    onClick={() => void runHostControl('start')}
                    disabled={actionBusy || snapshot.teams.length < 2}
                    className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer disabled:opacity-40"
                  >
                    <Play className="w-4 h-4" />
                    Start Live Auction
                  </button>
                </div>
              )}
            </div>
          )}

          {auction?.state === 'COMPLETED' && (
            <div className="bg-[#0B1325] border border-sky-500/30 rounded-xl p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="inline-flex items-center gap-2 text-sky-400 text-xs font-bold uppercase tracking-wider">
                  <Trophy className="w-4 h-4" /> Round {auction.roundNumber ?? 1} Completed
                </div>
                <h2 className="text-xl font-display font-bold text-white">Auction Round Finalized</h2>
                <p className="text-xs text-slate-400">
                  Sold: <span className="text-emerald-400 font-mono-num font-semibold">{auction.soldCount ?? 0}</span> ·
                  Unsold: <span className="text-amber-400 font-mono-num font-semibold">{auction.unsoldCount ?? 0}</span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                {isHost && auction.enableSecondRound && (auction.unsoldCount ?? 0) > 0 && (
                  <button
                    onClick={() => void runHostControl('unsoldRound')}
                    disabled={actionBusy}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
                  >
                    <Sparkles className="w-4 h-4" />
                    Start Round {(auction.roundNumber ?? 1) + 1} (Unsold Pool: {auction.unsoldCount})
                  </button>
                )}
                <button
                  onClick={() => onOpenTeam(snapshot.league.id)}
                  className="px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold cursor-pointer"
                >
                  Open Franchise Squad & Playing XI
                </button>
              </div>
            </div>
          )}

          {auction?.state === 'CANCELLED' && (
            <div className="bg-rose-950/30 border border-rose-500/40 rounded-xl p-6 text-center space-y-2">
              <XCircle className="w-8 h-8 text-rose-400 mx-auto" />
              <h2 className="text-lg font-display font-bold text-white">Auction Cancelled</h2>
              <p className="text-xs text-slate-400">This auction session was cancelled by the league owner.</p>
            </div>
          )}

          {/* MAIN 12-COLUMN LIVE ARENA */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
            {/* LEFT / CENTER STAGE (8 cols) */}
            <div className="xl:col-span-8 space-y-5">
              {/* Current Player + Live Bidding */}
              {currentPlayer && currentLot && auction && auction.state !== 'COMPLETED' && auction.state !== 'CANCELLED' && (
                <div className="bg-[#0B1325] border border-slate-800 rounded-xl overflow-hidden">
                  {/* Player Spotlight */}
                  <div className="p-5 sm:p-6 grid grid-cols-1 md:grid-cols-12 gap-5 border-b border-slate-800">
                    <div className="md:col-span-4 flex flex-col items-center justify-center bg-[#060B18] border border-slate-800 rounded-xl p-4">
                      <PlayerImage
                        src={currentPlayer.imageUrl}
                        alt={currentPlayer.name}
                        className="w-36 h-36 sm:w-44 sm:h-44 rounded-xl object-cover border border-slate-700"
                      />
                      <div className="mt-3 text-center">
                        <span className="font-mono-num text-[11px] text-amber-400 font-semibold">
                          {currentPlayer.playerCode} · LOT #{currentLot.lotNumber}
                        </span>
                        <div className="mt-1 flex items-center justify-center gap-2 text-xs">
                          <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200 font-medium">
                            {currentPlayer.nationality}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded font-semibold ${
                              currentPlayer.isOverseas
                                ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                                : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            }`}
                          >
                            {currentPlayer.isOverseas ? 'OVERSEAS' : 'DOMESTIC'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="md:col-span-8 flex flex-col justify-between gap-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wider text-amber-400">
                            {formatRoleLabel(currentPlayer.role)} · {currentPlayer.category} · {currentPlayer.experienceLevel}
                          </p>
                          <h2 className="text-2xl sm:text-3xl font-display font-bold text-white mt-1">
                            {currentPlayer.name}
                          </h2>
                          <p className="text-xs text-slate-400 mt-1">
                            Age {currentPlayer.age} · {currentPlayer.battingStyle} · {currentPlayer.bowlingStyle}
                          </p>
                        </div>
                        <div className="text-right shrink-0 bg-[#060B18] border border-slate-800 rounded-xl px-4 py-2.5">
                          <p className="text-[11px] text-slate-400 uppercase font-semibold">Overall</p>
                          <p className="text-3xl font-display font-bold font-mono-num text-amber-400">
                            {currentPlayer.overallRating}
                          </p>
                        </div>
                      </div>

                      {/* Core & Detailed Attributes */}
                      <div className="grid grid-cols-5 gap-2 text-xs">
                        {[
                          { label: 'BAT', val: currentPlayer.battingRating },
                          { label: 'TIM', val: currentPlayer.battingTiming },
                          { label: 'PWR', val: currentPlayer.powerHitting },
                          { label: 'BOWL', val: currentPlayer.bowlingRating },
                          { label: 'ACC', val: currentPlayer.bowlingAccuracy },
                          { label: 'SWG', val: currentPlayer.swing },
                          { label: 'SPN', val: currentPlayer.spin },
                          { label: 'FLD', val: currentPlayer.fieldingRating },
                          { label: 'STM', val: currentPlayer.stamina },
                          { label: 'EXP', val: currentPlayer.experienceRating },
                        ].map((attr) => (
                          <div key={attr.label} className="bg-[#060B18] border border-slate-800/80 rounded-lg p-2 text-center">
                            <p className="text-[10px] text-slate-400 font-semibold">{attr.label}</p>
                            <p className="font-mono-num font-bold text-white text-sm mt-0.5">{attr.val}</p>
                          </div>
                        ))}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/80 text-xs">
                        <div>
                          <span className="text-slate-400">Lot Base Price: </span>
                          <span className="font-mono-num font-bold text-white text-sm">
                            {formatCurrency(currentLot.basePrice)} ({currentLot.basePrice} L)
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400">Next Increment: </span>
                          <span className="font-mono-num font-semibold text-amber-400">
                            +{nextIncrement} L
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Live Bid Telemetry & Countdown */}
                  <div className="p-5 sm:p-6 bg-[#070E1E] space-y-5">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div className="bg-[#0B1325] border border-slate-800 rounded-xl p-4">
                        <p className="text-xs text-slate-400 font-medium">
                          {auction.currentBid !== null ? 'Current Highest Bid' : 'Opening Base Price'}
                        </p>
                        <p className="text-3xl font-display font-bold font-mono-num text-amber-400 mt-1">
                          {formatCurrency(auction.currentBid ?? currentLot.basePrice)}
                        </p>
                        <p className="text-[11px] font-mono-num text-slate-400 mt-0.5">
                          {(auction.currentBid ?? currentLot.basePrice)} Lakhs
                        </p>
                      </div>

                      <div className="bg-[#0B1325] border border-slate-800 rounded-xl p-4">
                        <p className="text-xs text-slate-400 font-medium">Current Highest Bidder</p>
                        {holdingTeam ? (
                          <div className="mt-1.5 flex items-center gap-2">
                            <span
                              className="w-3 h-3 rounded-full shrink-0"
                              style={{ backgroundColor: holdingTeam.primaryColor }}
                            />
                            <div className="min-w-0">
                              <p className="text-base font-display font-bold text-white truncate">
                                {holdingTeam.name}
                              </p>
                              <p className="text-xs text-slate-400 truncate">
                                Owner: {holdingTeam.ownerName || 'Franchise'}
                              </p>
                            </div>
                          </div>
                        ) : (
                          <p className="text-base font-display font-semibold text-slate-400 mt-2">
                            No bids placed yet
                          </p>
                        )}
                      </div>

                      <div className="bg-[#0B1325] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-400 flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5" /> Countdown
                          </span>
                          {auction.maxTimerExtensions != null && (
                            <span className="font-mono-num text-[11px] text-slate-400">
                              Ext {auction.timerExtensionsUsed ?? 0}/{auction.maxTimerExtensions}
                            </span>
                          )}
                        </div>
                        <p
                          className={`text-3xl font-display font-bold font-mono-num mt-1 ${
                            auction.state === 'PAUSED'
                              ? 'text-amber-400'
                              : remainingSeconds <= 5
                              ? 'text-rose-400'
                              : 'text-emerald-400'
                          }`}
                        >
                          {auction.state === 'PAUSED' ? `PAUSED (${remainingSeconds}s)` : `${remainingSeconds}s`}
                        </p>
                        <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mt-2">
                          <div
                            className={`h-full transition-all duration-200 ${
                              remainingSeconds <= 5 ? 'bg-rose-500' : 'bg-emerald-500'
                            }`}
                            style={{ width: `${timerProgressPct}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Bidding Actions for Participating Franchise */}
                    <div className="bg-[#0B1325] border border-slate-800 rounded-xl p-4 space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                        <div>
                          <span className="text-slate-400">Minimum Next Bid: </span>
                          <span className="font-mono-num font-bold text-white text-sm">
                            {formatCurrency(minimumNextBid)} ({minimumNextBid} L)
                          </span>
                        </div>
                        {myTeam && (
                          <div className="flex flex-wrap items-center gap-3 font-mono-num text-slate-300">
                            <span>
                              Your Purse: <strong className="text-amber-400">{formatCurrency(myTeam.remainingPurse)}</strong>
                            </span>
                            <span>
                              Slots: <strong className="text-white">{myTeam.availableSlots ?? 0}</strong>
                            </span>
                            <span>
                              Overseas: <strong className="text-white">{myTeam.overseasCount ?? 0}/{maxOverseasLimit}</strong>
                            </span>
                          </div>
                        )}
                      </div>

                      {bidGuardReason && (
                        <div className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-xs text-amber-300 flex items-center gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          <span>{bidGuardReason}</span>
                        </div>
                      )}

                      <div className="flex flex-col lg:flex-row gap-3">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 flex-1">
                          {[0, 1, 2, 3].map((step) => {
                            const bidVal = minimumNextBid + step * nextIncrement;
                            const label = step === 0 ? 'Bid Min' : `+${step}x (+${step * nextIncrement}L)`;
                            const disabled = Boolean(bidGuardReason) || actionBusy || (myTeam ? myTeam.remainingPurse < bidVal : true);
                            return (
                              <button
                                key={step}
                                onClick={() => void placeBidAmount(bidVal)}
                                disabled={disabled}
                                className={`px-3 py-3 rounded-lg text-xs font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${
                                  step === 0
                                    ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                                    : 'bg-[#060B18] hover:bg-slate-800 border border-slate-700 text-white'
                                }`}
                              >
                                <div>{label}</div>
                                <div className="font-mono-num text-[11px] opacity-90 mt-0.5">
                                  {formatCurrency(bidVal)}
                                </div>
                              </button>
                            );
                          })}
                        </div>

                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const val = Math.trunc(Number(customBidInput));
                            if (Number.isInteger(val) && val > 0) {
                              void placeBidAmount(val);
                            } else {
                              setBanner({ type: 'error', text: 'Enter a valid positive integer bid amount in Lakhs.' });
                            }
                          }}
                          className="flex items-center gap-2 shrink-0"
                        >
                          <input
                            type="number"
                            min={minimumNextBid}
                            step={1}
                            placeholder={`Custom (${minimumNextBid}+ L)`}
                            value={customBidInput}
                            onChange={(e) => setCustomBidInput(e.target.value)}
                            className="w-36 px-3 py-3 rounded-lg bg-[#060B18] border border-slate-700 text-white text-xs font-mono-num"
                          />
                          <button
                            type="submit"
                            disabled={Boolean(bidGuardReason) || actionBusy || !customBidInput}
                            className="px-4 py-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold cursor-pointer disabled:opacity-40"
                          >
                            Place Bid
                          </button>
                        </form>
                      </div>
                    </div>

                    {/* Host / Admin Auction Controls */}
                    {isHost && (
                      <div className="bg-[#0B1325] border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-xs text-slate-300 font-semibold">
                          <ShieldCheck className="w-4 h-4 text-amber-400" />
                          Auctioneer Controls
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {auction.state === 'PAUSED' ? (
                            <button
                              onClick={() => void runHostControl('resume')}
                              disabled={actionBusy}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold cursor-pointer"
                            >
                              <Play className="w-3.5 h-3.5" /> Resume
                            </button>
                          ) : (
                            <button
                              onClick={() => void runHostControl('pause')}
                              disabled={actionBusy}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-semibold cursor-pointer"
                            >
                              <Pause className="w-3.5 h-3.5" /> Pause
                            </button>
                          )}

                          {auction.allowSkipPlayer && auction.currentBid === null && (
                            <button
                              onClick={() => void runHostControl('skip')}
                              disabled={actionBusy}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#060B18] hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold cursor-pointer"
                            >
                              <SkipForward className="w-3.5 h-3.5" /> Skip Player
                            </button>
                          )}

                          <button
                            onClick={() => void runHostControl('nextLot')}
                            disabled={actionBusy}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/40 text-sky-300 text-xs font-semibold cursor-pointer"
                          >
                            <FastForward className="w-3.5 h-3.5" /> Finalize Lot
                          </button>

                          {confirmAction === 'end' ? (
                            <div className="inline-flex items-center gap-1.5 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1">
                              <span className="text-[11px] text-amber-300">End auction?</span>
                              <button
                                onClick={() => void runHostControl('end')}
                                className="px-2 py-1 rounded bg-rose-500 text-white text-[11px] font-bold cursor-pointer"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setConfirmAction(null)}
                                className="px-2 py-1 rounded bg-slate-700 text-slate-200 text-[11px] cursor-pointer"
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmAction('end')}
                              className="px-3.5 py-2 rounded-lg bg-[#060B18] hover:bg-slate-800 border border-slate-700 text-slate-300 text-xs font-semibold cursor-pointer"
                            >
                              End Auction
                            </button>
                          )}

                          {confirmAction === 'cancel' ? (
                            <div className="inline-flex items-center gap-1.5 bg-slate-900 border border-rose-500/40 rounded-lg px-2 py-1">
                              <span className="text-[11px] text-rose-300">Cancel room?</span>
                              <button
                                onClick={() => void runHostControl('cancel')}
                                className="px-2 py-1 rounded bg-rose-600 text-white text-[11px] font-bold cursor-pointer"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setConfirmAction(null)}
                                className="px-2 py-1 rounded bg-slate-700 text-slate-200 text-[11px] cursor-pointer"
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmAction('cancel')}
                              className="px-3.5 py-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-semibold cursor-pointer"
                            >
                              Cancel Auction
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Live Bidding History */}
                    <div className="bg-[#0B1325] border border-slate-800 rounded-xl p-4 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                          Live Bidding History ({snapshot.bids?.length ?? 0})
                        </h3>
                        <span className="text-[11px] text-slate-500">Server-Ordered Ledger</span>
                      </div>
                      {!snapshot.bids || snapshot.bids.length === 0 ? (
                        <p className="text-xs text-slate-500">No bids recorded for this auction yet.</p>
                      ) : (
                        <div className="max-h-44 overflow-y-auto divide-y divide-slate-800/70">
                          {snapshot.bids.slice(0, 15).map((b) => (
                            <div key={b.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className="w-2 h-2 rounded-full shrink-0"
                                  style={{ backgroundColor: b.teamColor || '#F59E0B' }}
                                />
                                <span className="font-semibold text-white">{b.teamShortName || 'TEAM'}</span>
                                <span className="text-slate-400 truncate">{b.bidderName}</span>
                                {b.status === 'REJECTED' && (
                                  <span className="text-rose-400 text-[11px]">({b.rejectionReason})</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span
                                  className={`font-mono-num font-bold ${
                                    b.status === 'ACCEPTED' ? 'text-amber-400' : 'text-rose-400 line-through'
                                  }`}
                                >
                                  {formatCurrency(b.amount)}
                                </span>
                                {b.isWinningBid && (
                                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Participating Teams Purse & Purchased Squads */}
              <div className="bg-[#0B1325] border border-slate-800 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-display font-bold text-white flex items-center gap-2">
                    <Users className="w-4 h-4 text-amber-400" />
                    Participating Franchises ({snapshot.teams.length})
                  </h3>
                  <span className="text-xs text-slate-400">
                    Click a team to inspect purchased players
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {snapshot.teams.map((t) => {
                    const isExpanded = expandedTeamId === t.id;
                    const isLeading = auction?.highestBidderTeamId === t.id;
                    return (
                      <div
                        key={t.id}
                        className={`bg-[#060B18] border rounded-xl p-4 transition-colors ${
                          isLeading ? 'border-amber-500/70' : 'border-slate-800'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setExpandedTeamId(isExpanded ? null : t.id)}
                          className="w-full text-left space-y-2.5 cursor-pointer"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className="w-3 h-3 rounded-full shrink-0"
                                style={{ backgroundColor: t.primaryColor }}
                              />
                              <div className="min-w-0">
                                <p className="text-sm font-display font-bold text-white truncate">
                                  {t.name}{' '}
                                  <span className="text-xs font-mono-num text-amber-400">({t.shortName})</span>
                                </p>
                                <p className="text-[11px] text-slate-400 truncate">
                                  Owner: {t.ownerName || 'Manager'} {t.ownerId === dbUser?.id ? '· You' : ''}
                                </p>
                              </div>
                            </div>
                            {isExpanded ? (
                              <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" />
                            ) : (
                              <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                            )}
                          </div>

                          <div className="grid grid-cols-4 gap-2 text-xs pt-1">
                            <div>
                              <p className="text-[10px] text-slate-500">Purse Left</p>
                              <p className="font-mono-num font-bold text-emerald-400">
                                {formatCurrency(t.remainingPurse)}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-slate-500">Purchased</p>
                              <p className="font-mono-num font-bold text-white">
                                {t.squadCount}/{snapshot.league.maxSquadSize}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-slate-500">Open Slots</p>
                              <p className="font-mono-num font-bold text-slate-200">{t.availableSlots ?? 0}</p>
                            </div>
                            <div>
                              <p className="text-[10px] text-slate-500">Overseas</p>
                              <p className="font-mono-num font-bold text-amber-400">
                                {t.overseasCount ?? 0}/{maxOverseasLimit}
                              </p>
                            </div>
                          </div>
                        </button>

                        {isExpanded && (
                          <div className="mt-3 pt-3 border-t border-slate-800 space-y-1.5">
                            <div className="text-[11px] text-slate-400 flex justify-between">
                              <span>
                                BAT {t.batsmenCount ?? 0} · BOWL {t.bowlersCount ?? 0} · AR {t.allRoundersCount ?? 0} · WK {t.wicketkeepersCount ?? 0}
                              </span>
                              <span className="font-mono-num">Spent: {formatCurrency(t.totalSpent ?? 0)}</span>
                            </div>
                            {!t.purchasedPlayers || t.purchasedPlayers.length === 0 ? (
                              <p className="text-xs text-slate-500 py-1">No players purchased yet.</p>
                            ) : (
                              <div className="max-h-40 overflow-y-auto divide-y divide-slate-800/60">
                                {t.purchasedPlayers.map((p) => (
                                  <div key={p.playerId} className="py-1.5 flex items-center justify-between text-xs">
                                    <div className="min-w-0">
                                      <span className="text-white font-medium">{p.name}</span>
                                      <span className="text-slate-400 ml-1.5 text-[11px]">
                                        {formatRoleLabel(p.role)} {p.isOverseas ? '· OS' : ''}
                                      </span>
                                    </div>
                                    <span className="font-mono-num text-amber-400 font-semibold shrink-0">
                                      {formatCurrency(p.purchasePrice)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* RIGHT RAIL: QUEUE, RESULTS, AUDIT LOGS (4 cols) */}
            <div className="xl:col-span-4 bg-[#0B1325] border border-slate-800 rounded-xl p-5 flex flex-col gap-4 h-fit">
              <div className="grid grid-cols-3 gap-1.5 bg-[#060B18] p-1 rounded-lg border border-slate-800">
                {(
                  [
                    { id: 'UP_NEXT', label: `Up Next (${snapshot.upNext.length})` },
                    { id: 'RESULTS', label: `Results (${snapshot.history.length})` },
                    { id: 'AUDIT', label: 'Event Log' },
                  ] as Array<{ id: RailTab; label: string }>
                ).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setRailTab(t.id)}
                    className={`py-2 px-2 rounded-md text-[11px] font-semibold cursor-pointer transition-colors ${
                      railTab === t.id ? 'bg-amber-500 text-slate-950' : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {railTab === 'UP_NEXT' && (
                <div className="space-y-2 max-h-[620px] overflow-y-auto">
                  {snapshot.upNext.length === 0 ? (
                    <p className="text-xs text-slate-400 py-6 text-center">No queued players remaining in current round.</p>
                  ) : (
                    snapshot.upNext.map((q) => (
                      <div key={q.id} className="p-3 rounded-lg bg-[#060B18] border border-slate-800/80 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-white truncate">
                            #{q.lotNumber} · {q.playerName}
                          </p>
                          <p className="text-[11px] text-slate-400">
                            {formatRoleLabel(q.playerRole)} · OVR {q.overallRating ?? '—'} {q.isOverseas ? '· OS' : ''}
                          </p>
                        </div>
                        <span className="font-mono-num text-xs font-bold text-amber-400 shrink-0">
                          {formatCurrency(q.basePrice)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}

              {railTab === 'RESULTS' && (
                <div className="space-y-2 max-h-[620px] overflow-y-auto">
                  {snapshot.history.length === 0 ? (
                    <p className="text-xs text-slate-400 py-6 text-center">No completed lots yet.</p>
                  ) : (
                    snapshot.history.map((h) => (
                      <div key={h.id} className="p-3 rounded-lg bg-[#060B18] border border-slate-800/80 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-white truncate">{h.playerName}</p>
                          <p className="text-[11px] text-slate-400 truncate">
                            {h.status === 'SOLD' ? `Sold to ${h.winningTeamName || h.winningTeamShort}` : 'Unsold'}
                          </p>
                        </div>
                        <span
                          className={`font-mono-num text-xs font-bold shrink-0 ${
                            h.status === 'SOLD' ? 'text-emerald-400' : 'text-slate-500'
                          }`}
                        >
                          {h.status === 'SOLD' ? formatCurrency(h.finalPrice) : 'UNSOLD'}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}

              {railTab === 'AUDIT' && (
                <div className="space-y-2 max-h-[620px] overflow-y-auto">
                  {snapshot.recentEvents.length === 0 ? (
                    <p className="text-xs text-slate-400 py-6 text-center">No events logged yet.</p>
                  ) : (
                    snapshot.recentEvents.map((ev) => (
                      <div key={ev.id} className="p-3 rounded-lg bg-[#060B18] border border-slate-800/80 space-y-1 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-mono-num font-bold text-amber-400">{ev.eventType}</span>
                          <span className="text-[10px] text-slate-500">
                            {new Date(ev.createdAt).toLocaleTimeString()}
                          </span>
                        </div>
                        {ev.amount != null && ev.amount > 0 && (
                          <p className="font-mono-num text-slate-200">{formatCurrency(ev.amount)}</p>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {/* PRE-START AUCTION CONFIGURATION MODAL */}
          {showConfigModal && (
            <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
              <form
                onSubmit={handleSaveConfig}
                className="bg-[#0B1325] border border-slate-700 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 space-y-5"
              >
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <div>
                    <h2 className="text-lg font-display font-bold text-white flex items-center gap-2">
                      <History className="w-4 h-4 text-amber-400" />
                      Auction Configuration & Rules
                    </h2>
                    <p className="text-xs text-slate-400">
                      {auction?.settingsLocked
                        ? 'Settings are permanently locked because the auction has started.'
                        : 'Configure purse, squad limits, timer extensions, tiered increments, and player order.'}
                    </p>
                  </div>
                  <button type="button" onClick={() => setShowConfigModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {auction?.settingsLocked && (
                  <div className="px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-center gap-2">
                    <Lock className="w-4 h-4 shrink-0" />
                    Configuration is locked while auction state is {auction.state}.
                  </div>
                )}

                <fieldset disabled={Boolean(auction?.settingsLocked)} className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs disabled:opacity-70">
                  <label className="space-y-1 sm:col-span-2">
                    <span className="text-slate-300 font-medium">Auction Display Name</span>
                    <input
                      value={configForm.name}
                      onChange={(e) => setConfigForm((f) => ({ ...f, name: e.target.value }))}
                      className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-300 font-medium">Virtual Purse (Lakhs, 10000 = 100 Cr)</span>
                    <input
                      type="number"
                      min={500}
                      max={100000}
                      value={configForm.purseAmount}
                      onChange={(e) => setConfigForm((f) => ({ ...f, purseAmount: Number(e.target.value) }))}
                      className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-300 font-medium">Countdown Timer (Seconds)</span>
                    <input
                      type="number"
                      min={5}
                      max={120}
                      value={configForm.timerSeconds}
                      onChange={(e) => setConfigForm((f) => ({ ...f, timerSeconds: Number(e.target.value) }))}
                      className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-300 font-medium">Min / Max Squad Size</span>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="number"
                        min={1}
                        max={25}
                        value={configForm.minSquadSize}
                        onChange={(e) => setConfigForm((f) => ({ ...f, minSquadSize: Number(e.target.value) }))}
                        className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                      />
                      <input
                        type="number"
                        min={1}
                        max={25}
                        value={configForm.maxSquadSize}
                        onChange={(e) => setConfigForm((f) => ({ ...f, maxSquadSize: Number(e.target.value) }))}
                        className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                      />
                    </div>
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-300 font-medium">Max Overseas / Max Extensions</span>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="number"
                        min={0}
                        max={12}
                        value={configForm.maxOverseas}
                        onChange={(e) => setConfigForm((f) => ({ ...f, maxOverseas: Number(e.target.value) }))}
                        className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                      />
                      <input
                        type="number"
                        min={0}
                        max={100}
                        placeholder="Unlimited"
                        value={configForm.maxTimerExtensions}
                        onChange={(e) => setConfigForm((f) => ({ ...f, maxTimerExtensions: e.target.value }))}
                        className="px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                      />
                    </div>
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-300 font-medium">Player Order Mode</span>
                    <select
                      value={configForm.playerOrderMode}
                      onChange={(e) => setConfigForm((f) => ({ ...f, playerOrderMode: e.target.value as PlayerOrderMode }))}
                      className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white"
                    >
                      <option value="ADMIN_DEFINED">Tiered Marquee / Caps / Domestic</option>
                      <option value="ROLE_BASED">Role Based (Bat → WK → AR → Bowl)</option>
                      <option value="RANDOM">Randomized Order</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-300 font-medium">Player Pool Limit</span>
                    <input
                      type="number"
                      min={1}
                      max={300}
                      placeholder="Full pool"
                      value={configForm.playerPoolLimit}
                      onChange={(e) => setConfigForm((f) => ({ ...f, playerPoolLimit: e.target.value }))}
                      className="w-full px-3 py-2 rounded-lg bg-[#060B18] border border-slate-700 text-white font-mono-num"
                    />
                  </label>

                  <div className="sm:col-span-2 bg-[#060B18] border border-slate-800 rounded-xl p-4 space-y-3">
                    <label className="flex items-center gap-2 text-white font-medium cursor-pointer">
                      <input
                        type="checkbox"
                        checked={configForm.useTieredIncrements}
                        onChange={(e) => setConfigForm((f) => ({ ...f, useTieredIncrements: e.target.checked }))}
                      />
                      Tiered Increments (&lt;1 Cr, 1–5 Cr, &gt;5 Cr)
                    </label>
                    {configForm.useTieredIncrements ? (
                      <div className="grid grid-cols-3 gap-2">
                        <label className="space-y-1">
                          <span className="text-slate-400">&lt;1 Cr (L)</span>
                          <input
                            type="number"
                            min={1}
                            value={configForm.tier1Increment}
                            onChange={(e) => setConfigForm((f) => ({ ...f, tier1Increment: Number(e.target.value) }))}
                            className="w-full px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-white font-mono-num"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-slate-400">1–5 Cr (L)</span>
                          <input
                            type="number"
                            min={1}
                            value={configForm.tier2Increment}
                            onChange={(e) => setConfigForm((f) => ({ ...f, tier2Increment: Number(e.target.value) }))}
                            className="w-full px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-white font-mono-num"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-slate-400">&gt;5 Cr (L)</span>
                          <input
                            type="number"
                            min={1}
                            value={configForm.tier3Increment}
                            onChange={(e) => setConfigForm((f) => ({ ...f, tier3Increment: Number(e.target.value) }))}
                            className="w-full px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-white font-mono-num"
                          />
                        </label>
                      </div>
                    ) : (
                      <label className="block space-y-1">
                        <span className="text-slate-400">Flat Increment (Lakhs)</span>
                        <input
                          type="number"
                          min={1}
                          value={configForm.bidIncrement}
                          onChange={(e) => setConfigForm((f) => ({ ...f, bidIncrement: Number(e.target.value) }))}
                          className="w-40 px-2.5 py-1.5 rounded bg-[#0B1325] border border-slate-700 text-white font-mono-num"
                        />
                      </label>
                    )}

                    <div className="flex flex-wrap gap-5 pt-1">
                      <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={configForm.enableSecondRound}
                          onChange={(e) => setConfigForm((f) => ({ ...f, enableSecondRound: e.target.checked }))}
                        />
                        Round 2 Unsold Players
                      </label>
                      <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={configForm.allowSkipPlayer}
                          onChange={(e) => setConfigForm((f) => ({ ...f, allowSkipPlayer: e.target.checked }))}
                        />
                        Allow Host Skip
                      </label>
                    </div>
                  </div>
                </fieldset>

                <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                  <button
                    type="button"
                    onClick={() => setShowConfigModal(false)}
                    className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-xs font-semibold cursor-pointer"
                  >
                    Close
                  </button>
                  {!auction?.settingsLocked && (
                    <button
                      type="submit"
                      disabled={actionBusy}
                      className="px-5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer disabled:opacity-50"
                    >
                      {actionBusy ? 'Saving...' : 'Save Rules'}
                    </button>
                  )}
                </div>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
};
