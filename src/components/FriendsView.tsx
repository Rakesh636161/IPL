import React, { useEffect, useState } from 'react';
import { Check, Search, UserCircle2, UserMinus, UserPlus, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import {
  lookupPlayerByUniqueIdFirestore,
  removeFriendFirestore,
  respondToFriendRequestFirestore,
  sendFriendRequestFirestore,
} from '../services/firestoreService.ts';
import { FriendEntry } from '../types/cricketverse.ts';

interface SearchResult {
  userId: string;
  uniquePlayerId: string;
  displayName: string;
  avatarUrl?: string | null;
  country: string | null;
  onlineStatus: string;
}

export const FriendsView: React.FC = () => {
  const { apiFetch, dbUser, firebaseUser } = useAuth();
  const [accepted, setAccepted] = useState<FriendEntry[]>([]);
  const [incoming, setIncoming] = useState<FriendEntry[]>([]);
  const [outgoing, setOutgoing] = useState<FriendEntry[]>([]);
  const [queryText, setQueryText] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFriends = async () => {
    try {
      const res = await apiFetch<{
        accepted: FriendEntry[];
        incomingRequests: FriendEntry[];
        outgoingRequests: FriendEntry[];
      }>('/api/friends');
      setAccepted(res.accepted || []);
      setIncoming(res.incomingRequests || []);
      setOutgoing(res.outgoingRequests || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load friends');
    }
  };

  useEffect(() => {
    loadFriends();
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    const trimmed = queryText.trim();
    if (!trimmed) return;

    setSearching(true);
    try {
      const [apiRes, fsExact] = await Promise.all([
        apiFetch<{ users: SearchResult[] }>(
          `/api/friends/search?q=${encodeURIComponent(trimmed)}`
        ),
        /^CV[0-9]{6,}$/i.test(trimmed)
          ? lookupPlayerByUniqueIdFirestore(trimmed).catch(() => null)
          : Promise.resolve(null),
      ]);

      const results = [...(apiRes.users || [])];
      if (
        fsExact &&
        fsExact.uniquePlayerId !== dbUser?.profile?.uniquePlayerId &&
        !results.some((r) => r.uniquePlayerId === fsExact.uniquePlayerId)
      ) {
        results.unshift({
          userId: fsExact.uid,
          uniquePlayerId: fsExact.uniquePlayerId,
          displayName: fsExact.username,
          avatarUrl: fsExact.photoUrl,
          country: 'Global',
          onlineStatus: fsExact.onlineStatus,
        });
      }

      setSearchResults(results);
      if (results.length === 0) {
        if (
          dbUser?.profile?.uniquePlayerId &&
          trimmed.toUpperCase() === dbUser.profile.uniquePlayerId.toUpperCase()
        ) {
          setFeedback('That is your own Unique Player ID. Enter another player ID to connect.');
        } else {
          setFeedback('No franchise owners matched that Unique Player ID or name.');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  const sendRequest = async (uniquePlayerId: string) => {
    setError(null);
    setFeedback(null);
    if (
      dbUser?.profile?.uniquePlayerId &&
      uniquePlayerId.toUpperCase() === dbUser.profile.uniquePlayerId.toUpperCase()
    ) {
      setError('You cannot send a friend request to yourself.');
      return;
    }

    try {
      await apiFetch('/api/friends/request', {
        method: 'POST',
        body: JSON.stringify({ uniquePlayerId }),
      });
      if (firebaseUser?.uid && dbUser?.profile?.uniquePlayerId) {
        await sendFriendRequestFirestore({
          senderUid: firebaseUser.uid,
          senderPlayerId: dbUser.profile.uniquePlayerId,
          senderUsername: dbUser.profile.displayName,
          senderPhotoUrl: dbUser.profile.avatarUrl,
          receiverPlayerId: uniquePlayerId,
        }).catch(() => undefined);
      }
      setFeedback(`Friend request sent to ${uniquePlayerId}.`);
      await loadFriends();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send request');
    }
  };

  const respond = async (
    friendshipId: string,
    otherPlayerId: string,
    action: 'ACCEPT' | 'REJECT'
  ) => {
    setError(null);
    setFeedback(null);
    try {
      await apiFetch('/api/friends/respond', {
        method: 'POST',
        body: JSON.stringify({ friendshipId, action }),
      });
      if (firebaseUser?.uid && dbUser?.profile?.uniquePlayerId) {
        await respondToFriendRequestFirestore({
          currentUid: firebaseUser.uid,
          currentUsername: dbUser.profile.displayName,
          currentPlayerId: dbUser.profile.uniquePlayerId,
          otherPlayerId,
          action,
        }).catch(() => undefined);
      }
      setFeedback(action === 'ACCEPT' ? 'Friend request accepted.' : 'Friend request declined.');
      await loadFriends();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to respond to request');
    }
  };

  const remove = async (friendshipId: string, otherPlayerId: string) => {
    setError(null);
    setFeedback(null);
    try {
      await apiFetch(`/api/friends/${friendshipId}`, { method: 'DELETE' });
      if (firebaseUser?.uid) {
        await removeFriendFirestore(firebaseUser.uid, otherPlayerId).catch(() => undefined);
      }
      setFeedback('Friend removed from your roster.');
      await loadFriends();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove friend');
    }
  };

  const acceptedIds = new Set(accepted.map((f) => f.uniquePlayerId));
  const pendingIncomingIds = new Set(incoming.map((f) => f.uniquePlayerId));
  const pendingOutgoingIds = new Set(outgoing.map((f) => f.uniquePlayerId));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Friends &amp; Rivals</h1>
          <p className="text-sm text-slate-400">
            Search franchise owners by Unique Player ID (e.g. CV100001), manage requests, and track online status.
          </p>
        </div>
        {dbUser?.profile?.uniquePlayerId && (
          <div className="text-xs text-slate-400 font-mono-num">
            Your ID: <span className="text-amber-400 font-semibold">{dbUser?.profile?.uniquePlayerId || 'Assigning...'}</span>
          </div>
        )}
      </div>

      {/* Search Bar */}
      <form onSubmit={handleSearch} className="p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="Enter Unique Player ID (e.g. CV100001) or Owner Name"
              className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-[#060B18] border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
            />
          </div>
          <button
            type="submit"
            disabled={searching}
            className="px-5 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold whitespace-nowrap disabled:opacity-60 cursor-pointer"
          >
            {searching ? 'Searching...' : 'Find Player'}
          </button>
        </div>

        {error && <div className="text-xs text-red-300">{error}</div>}
        {feedback && <div className="text-xs text-emerald-300">{feedback}</div>}

        {searchResults.length > 0 && (
          <div className="divide-y divide-slate-800/80 border-t border-slate-800 pt-2">
            {searchResults.map((u) => {
              const isFriend = acceptedIds.has(u.uniquePlayerId);
              const isOutgoing = pendingOutgoingIds.has(u.uniquePlayerId);
              const isIncoming = pendingIncomingIds.has(u.uniquePlayerId);

              return (
                <div key={u.uniquePlayerId} className="py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    {u.avatarUrl ? (
                      <img
                        src={u.avatarUrl}
                        alt={u.displayName}
                        referrerPolicy="no-referrer"
                        className="w-9 h-9 rounded-lg object-cover border border-slate-700"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-lg bg-[#060B18] border border-slate-800 flex items-center justify-center">
                        <UserCircle2 className="w-5 h-5 text-slate-400" />
                      </div>
                    )}
                    <div>
                      <div className="text-sm font-semibold text-white">{u.displayName}</div>
                      <div className="text-xs text-slate-400 font-mono-num">
                        {u.uniquePlayerId} · {u.country || 'Global'} · {u.onlineStatus}
                      </div>
                    </div>
                  </div>

                  {isFriend ? (
                    <span className="text-xs font-semibold text-emerald-400">Friends</span>
                  ) : isOutgoing ? (
                    <span className="text-xs font-semibold text-amber-400">Request Sent</span>
                  ) : isIncoming ? (
                    <span className="text-xs font-semibold text-sky-400">Respond Below</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => sendRequest(u.uniquePlayerId)}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      <span>Add Friend</span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </form>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Friends List */}
        <div className="lg:col-span-7 p-6 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-4">
          <h2 className="text-base font-display font-semibold text-white">
            Connected Friends ({accepted.length})
          </h2>
          {accepted.length === 0 ? (
            <p className="text-xs text-slate-400">No connected friends yet.</p>
          ) : (
            <div className="divide-y divide-slate-800/70">
              {accepted.map((f) => (
                <div key={f.friendshipId} className="py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {f.avatarUrl ? (
                      <img
                        src={f.avatarUrl}
                        alt={f.displayName}
                        referrerPolicy="no-referrer"
                        className="w-9 h-9 rounded-lg object-cover border border-slate-700"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-lg bg-[#060B18] border border-slate-800 flex items-center justify-center">
                        <UserCircle2 className="w-5 h-5 text-slate-400" />
                      </div>
                    )}
                    <div>
                      <div className="text-sm font-semibold text-white">{f.displayName}</div>
                      <div className="text-xs text-slate-400 font-mono-num">
                        {f.uniquePlayerId} · {f.country || 'Global'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`text-xs font-semibold ${
                        f.onlineStatus === 'IN_AUCTION'
                          ? 'text-amber-400'
                          : f.onlineStatus === 'ONLINE'
                          ? 'text-emerald-400'
                          : 'text-slate-500'
                      }`}
                    >
                      {f.onlineStatus}
                    </span>
                    <button
                      onClick={() => remove(f.friendshipId, f.uniquePlayerId)}
                      title="Remove friend"
                      className="p-2 rounded-lg bg-slate-800/80 hover:bg-red-950/60 text-slate-400 hover:text-red-300 transition-colors cursor-pointer"
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Requests */}
        <div className="lg:col-span-5 space-y-5">
          <div className="p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-3">
            <h2 className="text-sm font-display font-semibold text-white">
              Incoming Requests ({incoming.length})
            </h2>
            {incoming.length === 0 ? (
              <p className="text-xs text-slate-400">No pending incoming requests.</p>
            ) : (
              <div className="space-y-2.5">
                {incoming.map((r) => (
                  <div
                    key={r.friendshipId}
                    className="p-3 rounded-lg bg-[#060B18] border border-slate-800 flex items-center justify-between gap-3"
                  >
                    <div>
                      <div className="text-xs font-semibold text-white">{r.displayName}</div>
                      <div className="text-[11px] text-slate-400 font-mono-num">{r.uniquePlayerId}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => respond(r.friendshipId, r.uniquePlayerId, 'ACCEPT')}
                        className="p-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer"
                        title="Accept"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => respond(r.friendshipId, r.uniquePlayerId, 'REJECT')}
                        className="p-1.5 rounded-md bg-slate-800 hover:bg-red-900 text-slate-300 cursor-pointer"
                        title="Reject"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="p-5 rounded-xl bg-[#0B1325] border border-slate-800/80 space-y-3">
            <h2 className="text-sm font-display font-semibold text-white">
              Outgoing Requests ({outgoing.length})
            </h2>
            {outgoing.length === 0 ? (
              <p className="text-xs text-slate-400">No outgoing requests.</p>
            ) : (
              <ul className="space-y-2 text-xs text-slate-300">
                {outgoing.map((r) => (
                  <li key={r.friendshipId} className="flex items-center justify-between">
                    <span>{r.displayName}</span>
                    <span className="font-mono-num text-slate-500">{r.uniquePlayerId}</span>
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
