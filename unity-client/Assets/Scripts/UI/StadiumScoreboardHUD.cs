using TMPro;
using UnityEngine;

namespace CricketVerse.UI
{
    public class StadiumScoreboardHUD : MonoBehaviour
    {
        public TMP_Text teamScoreText;
        public TMP_Text oversText;
        public TMP_Text strikerText;

        public void UpdateScoreboard(string shortName, int runs, int wickets, int overs, int balls, string striker)
        {
            if (teamScoreText != null) teamScoreText.text = $"{shortName} {runs}/{wickets}";
            if (oversText != null) oversText.text = $"{overs}.{balls} OV";
            if (strikerText != null) strikerText.text = striker;
        }
    }
}
