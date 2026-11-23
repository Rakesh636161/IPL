using System;
using System.Collections.Generic;

namespace CricketVerse.Models
{
    [Serializable]
    public class TeamRosterResponse
    {
        public TeamInfo team;
        public List<RosterEntry> roster;
    }

    [Serializable]
    public class TeamInfo
    {
        public string id;
        public string leagueId;
        public string name;
        public string shortName;
        public string primaryColor;
        public int totalPurse;
        public int remainingPurse;
        public int squadCount;
        public string captainPlayerId;
        public string viceCaptainPlayerId;
        public string wicketkeeperPlayerId;
    }

    [Serializable]
    public class RosterEntry
    {
        public string teamPlayerId;
        public int purchasePrice;
        public bool isPlayingXi;
        public int battingOrder;
        public int bowlingOrder;
        public PlayerStats player;
    }

    [Serializable]
    public class PlayerStats
    {
        public string id;
        public string playerCode;
        public string name;
        public string role;
        public string battingStyle;
        public string bowlingStyle;
        public int battingRating;
        public int bowlingRating;
        public int fieldingRating;
        public int consistencyRating;
        public int experienceRating;
    }
}
