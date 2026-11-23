using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;
using CricketVerse.Models;

namespace CricketVerse.Networking
{
    /// <summary>
    /// Authoritative REST API bridge connecting the Unity 6 LTS URP client
    /// to the CricketVerse Node.js/PostgreSQL backend.
    /// </summary>
    public class BackendApiClient : MonoBehaviour
    {
        [SerializeField] private string baseUrl = "http://localhost:3000/api";
        private string _firebaseIdToken;

        public void SetAuthToken(string token) => _firebaseIdToken = token;

        public IEnumerator FetchTeamRoster(string teamId, Action<TeamRosterResponse> onSuccess, Action<string> onError)
        {
            using var request = UnityWebRequest.Get($"{baseUrl}/teams/{teamId}");
            request.SetRequestHeader("Authorization", $"Bearer {_firebaseIdToken}");
            yield return request.SendWebRequest();

            if (request.result != UnityWebRequest.Result.Success)
            {
                onError?.Invoke(request.error);
                yield break;
            }

            var payload = JsonUtility.FromJson<TeamRosterResponse>(request.downloadHandler.text);
            onSuccess?.Invoke(payload);
        }

        public IEnumerator SubmitMatchSimulation(string homeTeamId, string awayTeamId, string mode, string leagueId, Action<string> onComplete)
        {
            string body = $"{{\"homeTeamId\":\"{homeTeamId}\",\"awayTeamId\":\"{awayTeamId}\",\"mode\":\"{mode}\",\"leagueId\":\"{leagueId}\"}}";
            using var request = new UnityWebRequest($"{baseUrl}/matches/simulate", "POST");
            request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");
            request.SetRequestHeader("Authorization", $"Bearer {_firebaseIdToken}");
            yield return request.SendWebRequest();
            onComplete?.Invoke(request.downloadHandler.text);
        }
    }
}
