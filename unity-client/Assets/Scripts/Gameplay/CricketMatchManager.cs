using UnityEngine;
using CricketVerse.Models;
using CricketVerse.Networking;

namespace CricketVerse.Gameplay
{
    public enum MatchPhase { PreToss, FirstInnings, InningsBreak, SecondInnings, Completed }

    public class CricketMatchManager : MonoBehaviour
    {
        [Header("Controllers")]
        public BattingController battingController;
        public BowlingController bowlingController;
        public FieldingController fieldingController;
        public BallPhysicsController ballPhysics;
        public BackendApiClient apiClient;

        public MatchPhase CurrentPhase { get; private set; } = MatchPhase.PreToss;
        public int TotalOvers { get; private set; } = 20;
        public int Runs { get; private set; }
        public int Wickets { get; private set; }

        public void InitializeMatch(TeamRosterResponse homeSquad, TeamRosterResponse awaySquad, int overs = 20)
        {
            TotalOvers = overs;
            Runs = 0;
            Wickets = 0;
            CurrentPhase = MatchPhase.FirstInnings;
            Debug.Log($"[CricketVerse 3D] Initialized {homeSquad.team.shortName} vs {awaySquad.team.shortName}");
        }

        public void RecordDeliveryOutcome(int runsScored, bool isWicket)
        {
            Runs += runsScored;
            if (isWicket) Wickets++;
        }
    }

    public class BattingController : MonoBehaviour
    {
        public float timingWindowSeconds = 0.22f;
        public void TriggerShot(Vector2 inputDirection, float powerNormalized)
        {
            // Driven by Unity Input System & player battingRating
        }
    }

    public class BowlingController : MonoBehaviour
    {
        public void ReleaseDelivery(Vector3 targetPitchPoint, float speedKph, float swingAmount)
        {
            // Driven by player bowlingRating & delivery type
        }
    }

    public class FieldingController : MonoBehaviour
    {
        public void AssignFieldPreset(string presetName)
        {
            // Powerplay, Ring, Death overs positioning
        }
    }

    public class BallPhysicsController : MonoBehaviour
    {
        public float seamFriction = 0.35f;
        public float pitchBounce = 0.72f;
    }
}
