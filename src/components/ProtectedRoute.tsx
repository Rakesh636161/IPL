import React from 'react';
import { useAuth } from '../context/AuthContext.tsx';
import { AuthScreen } from './AuthScreen.tsx';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { firebaseUser, dbUser, loading, authReady, authError, refreshSession, logout } = useAuth();

  if (loading || !authReady) {
    return (
      <div className="min-h-screen bg-[#060B18] flex flex-col items-center justify-center gap-3 text-slate-300">
        <div className="text-2xl font-display font-bold text-white tracking-tight">CricketVerse</div>
        <div className="text-xs text-slate-400">Verifying franchise session...</div>
      </div>
    );
  }

  if (!firebaseUser) {
    return <AuthScreen />;
  }

  if (!dbUser && authError) {
    return (
      <div className="min-h-screen bg-[#060B18] flex items-center justify-center p-6 text-slate-200">
        <div className="max-w-md w-full rounded-xl bg-[#0B1325] border border-slate-800 p-6 space-y-4 text-center">
          <div className="text-xl font-display font-bold text-white">CricketVerse</div>
          <p className="text-xs text-red-300">{authError}</p>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => void refreshSession()}
              className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer"
            >
              Retry Connection
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold cursor-pointer"
            >
              Back to Sign In
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!dbUser) {
    return (
      <div className="min-h-screen bg-[#060B18] flex flex-col items-center justify-center gap-3 text-slate-300">
        <div className="text-2xl font-display font-bold text-white tracking-tight">CricketVerse</div>
        <div className="text-xs text-slate-400">Synchronizing franchise profile...</div>
      </div>
    );
  }

  return <>{children}</>;
};
