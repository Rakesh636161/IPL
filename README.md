# CricketVerse — Multiplayer Cricket Auction & Franchise League

CricketVerse is a full-stack, server-authoritative multiplayer cricket auction and franchise management platform with a **Unity 6 LTS (URP)** client architecture foundation.

## Architecture & Directory Structure

- `server.ts` — Express HTTP + Socket.IO + Vite runtime entrypoint on port `3000`.
- `server/` — Modular backend services (`auctionEngine.ts`, `leagueService.ts`, `friendService.ts`, `teamService.ts`, `matchService.ts`), Firebase Auth middleware (`middleware/auth.ts`), REST routes (`routes/api.ts`), and Socket.IO room handlers (`socket/auctionSocket.ts`).
- `src/db/` — Normalized PostgreSQL schema (`schema.ts`), Cloud SQL `pg.Pool` connection (`index.ts`), Drizzle Kit config (`drizzle.config.ts`), and 120-player fictional seed data (`seedPlayers.ts`).
- `src/` — React + TypeScript + Tailwind CSS auction room, franchise dashboard, friend network, squad/Playing XI manager, player pool, and match center.
- `unity-client/` — Unity 6 LTS URP C# client architecture (`BackendApiClient.cs`, `SquadConfigModels.cs`, `CricketMatchManager.cs`, `StadiumScoreboardHUD.cs`).
- `tests/` — Automated unit and 12-participant concurrent bidding integration tests.

> Note: Cloud SQL in AI Studio uses **PostgreSQL** with **Drizzle ORM** (`drizzle-orm/node-postgres` + `drizzle-kit`).

## Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Database (PostgreSQL via Docker Compose — handles primary storage, distributed locks, and real-time state cache)**:
   ```bash
   docker compose up -d postgres
   ```
3. **Push schema migrations**:
   ```bash
   npm run db:push
   ```
4. **Run the full-stack server (port 3000)**:
   ```bash
   npm run dev
   ```
5. **Run automated tests (including 12-team simultaneous auction stress test)**:
   ```bash
   npm test
   ```

## Core API Endpoints

- `GET /api/me` — Sync Firebase user and return profile + Unique Player ID + notifications.
- `PATCH /api/me/profile` — Update owner display name, region, and bio.
- `GET /api/friends`, `GET /api/friends/search?q=`, `POST /api/friends/request`, `POST /api/friends/respond`, `DELETE /api/friends/:id`.
- `GET /api/leagues`, `POST /api/leagues`, `POST /api/leagues/join`, `GET /api/leagues/:id`, `POST /api/leagues/:id/ready`, `POST /api/leagues/:id/invite`.
- `GET /api/players` — Filterable 120+ fictional player registry; `POST /api/admin/players/import` (admin).
- `GET /api/auctions/:leagueId`, `POST /api/auctions/:leagueId/start`, `POST /api/auctions/:leagueId/bid`, `POST /api/auctions/:leagueId/pause`, `POST /api/auctions/:leagueId/resume`, `POST /api/auctions/:leagueId/finalize-lot`.
- `GET /api/teams/mine`, `GET /api/teams/:teamId`, `PUT /api/teams/:teamId/lineup`.
- `POST /api/matches/simulate`, `GET /api/leagues/:id/standings`.

## Socket.IO Events

Authenticated via Firebase ID token in `socket.handshake.auth.token`:
- Client -> Server: `auction:join`, `auction:start`, `auction:bid`, `auction:pause`, `auction:resume`, `auction:nextLot`
- Server -> Client: `auction:stateSync`, `auction:started`, `auction:player`, `auction:bidAccepted`, `auction:bidRejected`, `auction:timer`, `auction:sold`, `auction:unsold`, `auction:paused`, `auction:resumed`, `auction:completed`
