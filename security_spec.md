# CricketVerse Firestore Security Specification

## 1. Data Invariants
1. **PII Isolation**: `/users/{userId}` holds `email` and `role`. Only the owner (`request.auth.uid == userId`) can `get` their own document. Blanket `list` is denied.
2. **Immutable Unique Player ID**: `uniquePlayerId` (`^CV[0-9]{6,}$`) is assigned atomically and cannot be altered via client updates on `/users/{userId}`, `/user_profiles/{userId}`, or `/player_directory/{playerId}`.
3. **No Role Escalation**: Clients cannot create or mutate `role: 'ADMIN'` on `/users/{userId}`.
4. **No Self-Friending & No Duplicates**: `friend_requests` and `friends` use deterministic pair IDs and enforce `senderId != receiverId` and `user1Id != user2Id`.
5. **Relational & Atomic Friend Acceptance**: Creating `/friends/{friendshipId}` requires `getAfter(/databases/$(database)/documents/friend_requests/$(friendshipId)).data.status == 'ACCEPTED'`.
6. **Terminal State Locking**: Once `friend_requests` reaches `ACCEPTED`/`REJECTED`, or `leagues` reaches `COMPLETED`/`CANCELLED`, terminal states cannot be reopened.
7. **Strict Query Enforcement**: All `allow list` rules explicitly verify `resource.data` ownership/visibility/participation without calling `get()` or `exists()`.
8. **Private League & Invite Code Secrecy**: `allow list` on `/leagues` only permits `visibility == 'PUBLIC'` or `request.auth.uid in resource.data.memberIds`. `/league_invite_codes/{inviteCode}` denies `allow list` completely so invite codes cannot be enumerated. `/league_settings/{leagueId}` restricts reads to current league members.
9. **Unique Membership & 1 Team Per Member Per League**: `/league_members/{leagueId}__{uid}` and `/league_teams/{leagueId}__{uid}` use deterministic composite IDs and atomic `existsAfter`/`getAfter` guards on `/leagues/{leagueId}` so duplicate joins or double teams are impossible.
10. **Owner-Only Settings, Removal & Ownership Transfer**: Non-owner members cannot modify `/league_settings/{leagueId}`, kick other members, cancel the league, or transfer ownership.
11. **Controlled League State Transitions**: `/leagues/{leagueId}` status can only transition cleanly across `CREATED`, `OPEN`, `FULL`, `READY`, `AUCTION_IN_PROGRESS`, `COMPLETED`, and `CANCELLED` within bounded `participantCount <= maxParticipants` (`2..12`).

## 2. Adversarial "Dirty Dozen+" Payloads (All Must Fail with PERMISSION_DENIED)
1. **Unauthenticated read on `/users/{uid}`**: `auth: null`, `get('/users/u1')` -> DENIED.
2. **Cross-user PII read**: `auth: u2`, `get('/users/u1')` -> DENIED.
3. **Scrape `/user_profiles` via `list`**: `auth: u2`, `list('/user_profiles')` -> DENIED (`uid != u2`).
4. **Modify immutable `uniquePlayerId`**: `auth: u1`, `update('/user_profiles/u1', { uniquePlayerId: 'CV999999' })` -> DENIED.
5. **Privilege escalation on `/users/{uid}`**: `auth: u1`, `update('/user_users/u1', { role: 'ADMIN' })` -> DENIED.
6. **Shadow Ghost Field injection**: `auth: u1`, `update('/leagues/L1', { name: 'Hack', isVerified: true })` -> DENIED (`hasOnly` + `affectedKeys().hasOnly(...)`).
7. **ID Poisoning (>128 chars or invalid chars)**: `auth: u1`, `get('/leagues/' + 'a'.repeat(300))` -> DENIED (`isValidId`).
8. **Self-friending request**: `auth: u1`, `create('/friend_requests/u1__u1', { senderId: 'u1', receiverId: 'u1', ... })` -> DENIED.
9. **Scrape `/league_invite_codes` via `list`**: `auth: u1`, `list('/league_invite_codes')` -> DENIED.
10. **Non-owner modifies league settings**: `auth: u2` (member, not owner), `update('/league_settings/L1', { startingPurse: 99999 })` -> DENIED.
11. **Join full or started league**: `auth: u3`, `update('/leagues/L1', { participantCount: 13 })` or when `status == 'AUCTION_IN_PROGRESS'` -> DENIED.
12. **Join private league without valid invite code or accepted invite**: `auth: u3`, `create('/league_members/L1__u3', { joinedViaCode: 'FAKE-123' })` -> DENIED.
13. **Member customizes another member's team**: `auth: u2`, `update('/league_teams/L1__u3', { teamName: 'Hijacked' })` -> DENIED.
14. **Modify league after CANCELLED or COMPLETED**: `auth: u1`, `update('/leagues/L1', { status: 'OPEN' })` when `existing().status == 'CANCELLED'` -> DENIED.
15. **Non-admin modifies centralized player pool**: `auth: u2` (non-admin), `create('/players/p999', ...)` or `update('/player_attributes/p1', ...)` -> DENIED.
16. **Duplicate player purchase in the same league**: `auth: u2`, `create('/team_players/L1__p1', ...)` when `L1__p1` already exists -> DENIED (`allow create` rejects existing doc; cross-league `L2__p1` succeeds independently).
17. **Cross-team Playing XI injection**: `auth: u2`, `update('/playing_xi/L1__u1', { playingXiIds: [...] })` -> DENIED (`ownerId != u2`).
18. **Oversized Playing XI (>11) or oversized substitutes (>25)**: `auth: u1`, `update('/playing_xi/L1__u1', { playingXiIds: [12 ids] })` -> DENIED (`size() <= 11`).
19. **Non-owner edits league squad_settings**: `auth: u2`, `update('/squad_settings/L1', { maxOverseas: 11 })` -> DENIED.
20. **Client self-escalation into `/admins`**: `auth: u2`, `create('/admins/u2', { role: 'ADMIN' })` -> DENIED.
21. **Settings Lock After Auction Start**: `auth: u1`, `update('/auctions/L1', { timerSeconds: 60 })` when `existing().settingsLocked == true` -> DENIED.
22. **Non-member reads or bids in private auction**: `auth: u_outsider`, `get('/auctions/L1')` or `create('/auction_bids/b1', ...)` -> DENIED.
23. **Floating-point or negative purse / bid tampering**: `auth: u1`, `update('/team_purses/L1__u1', { remainingPurse: -100 })` or `create('/auction_bids/b2', { amount: 0 })` -> DENIED.
24. **Mutating immutable `/auction_bids` or `/auction_events` history**: `auth: u1`, `update('/auction_bids/b1', { amount: 1 })` or `delete('/auction_events/e1')` -> DENIED.


