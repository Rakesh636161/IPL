# CricketVerse Unity 6 LTS Client Architecture

This directory houses the C# foundation for the **Unity 6 LTS (URP)** 3D cricket gameplay client.

## Architecture Modules
- `Assets/Scripts/Models/SquadConfigModels.cs`: Data contracts synced with `/api/teams/:teamId` so every player purchased in the multiplayer auction loads into the 3D stadium with their exact batting, bowling, fielding, consistency, and experience ratings.
- `Assets/Scripts/Networking/BackendApiClient.cs`: Authenticated HTTP client using Firebase ID Tokens to fetch drafted squads and report competitive match outcomes.
- `Assets/Scripts/Gameplay/CricketMatchManager.cs`: Core match phase state machine, `BattingController`, `BowlingController`, `FieldingController`, and `BallPhysicsController` stubs ready for Unity Input System and Addressables stadium/character packs.
- `Assets/Scripts/UI/StadiumScoreboardHUD.cs`: Broadcast overlay HUD for live match scorecards.
