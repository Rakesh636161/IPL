import React, { useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, Gavel, Mail, Shield, Trophy, Users } from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { firebaseConfigError, firebaseProjectId, isFirebaseConfigured } from '../lib/firebase.ts';

type AuthMode = 'LOGIN' | 'REGISTER' | 'FORGOT_PASSWORD';

export const AuthScreen: React.FC = () => {
  const { signInWithEmail, registerWithEmail, resetPassword, authError } = useAuth();
  const [mode, setMode] = useState<AuthMode>('LOGIN');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [resetSentMessage, setResetSentMessage] = useState<string | null>(null);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setLocalError(null);
    setResetSentMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setResetSentMessage(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setLocalError('Please enter a valid email address.');
      return;
    }

    if (mode === 'FORGOT_PASSWORD') {
      setSubmitting(true);
      try {
        await resetPassword(trimmedEmail);
        setResetSentMessage(
          `Password reset link sent to ${trimmedEmail}. Check your inbox and spam folder to complete the reset.`
        );
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'Unable to send password reset email.');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (password.length < 6) {
      setLocalError('Password must be at least 6 characters long.');
      return;
    }

    if (mode === 'REGISTER') {
      if (displayName.trim().length < 2 || displayName.trim().length > 40) {
        setLocalError('Username / Owner Name must be between 2 and 40 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setLocalError('Passwords do not match.');
        return;
      }
    }

    setSubmitting(true);
    try {
      if (mode === 'LOGIN') {
        await signInWithEmail(trimmedEmail, password);
      } else {
        await registerWithEmail(trimmedEmail, password, displayName);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const errorText = localError || authError;

  return (
    <div className="min-h-screen bg-[#060B18] text-slate-100 grid lg:grid-cols-12">
      {/* Left Hero Showcase */}
      <div className="lg:col-span-7 relative flex flex-col justify-between p-8 lg:p-14 overflow-hidden min-h-[380px]">
        <img
          src="/src/assets/images/cricket_stadium_night_1794578450905.jpg"
          alt="CricketVerse Floodlit Arena"
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover opacity-55"
        />
        <div className="absolute inset-0 bg-gradient-to-tr from-[#060B18] via-[#060B18]/80 to-transparent" />

        <div className="relative z-10 flex items-center gap-3">
          <span className="text-2xl font-display font-bold tracking-tight text-white">
            CricketVerse
          </span>
        </div>

        <div className="relative z-10 max-w-2xl space-y-6 my-10">
          <p className="text-sm font-medium text-amber-400 tracking-wide">
            Franchise Auction &amp; Championship Platform
          </p>
          <h1 className="text-4xl sm:text-5xl font-display font-bold leading-[1.08] text-white [text-wrap:balance]">
            Command the Auction Room. Build a Dynasty.
          </h1>
          <p className="text-base text-slate-300 leading-relaxed max-w-xl">
            Host private or public leagues for 2 to 12 franchises. Bid in real time with
            server-authoritative purse controls, manage your Playing XI, and compete for the title.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-slate-800/80">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-amber-400 text-sm font-semibold">
                <Gavel className="w-4 h-4 shrink-0" />
                <span>Live 20s Clock</span>
              </div>
              <p className="text-xs text-slate-400">Synchronized Socket.IO bidding rooms</p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
                <Users className="w-4 h-4 shrink-0" />
                <span>2–12 Franchises</span>
              </div>
              <p className="text-xs text-slate-400">Invite friends via CV Player ID</p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sky-400 text-sm font-semibold">
                <Trophy className="w-4 h-4 shrink-0" />
                <span>128 Player Pool</span>
              </div>
              <p className="text-xs text-slate-400">Balanced ratings across all roles</p>
            </div>
          </div>
        </div>

        <div className="relative z-10 text-xs text-slate-400 flex items-center gap-2">
          <Shield className="w-3.5 h-3.5 text-amber-400" />
          <span>Firebase Auth &amp; Firestore Security · Sequential CV Player ID Identity</span>
        </div>
      </div>

      {/* Right Authentication Panel (Email & Password) */}
      <div className="lg:col-span-5 flex items-center justify-center p-6 sm:p-12 bg-[#0A1122] border-t lg:border-t-0 lg:border-l border-slate-800/80">
        <div className="w-full max-w-md space-y-6">
          <div className="space-y-2">
            <h2 className="text-2xl font-display font-bold text-white">
              {mode === 'FORGOT_PASSWORD'
                ? 'Reset Account Password'
                : mode === 'REGISTER'
                ? 'Create Franchise Account'
                : 'Owner Sign In'}
            </h2>
            <p className="text-sm text-slate-400">
              {mode === 'FORGOT_PASSWORD'
                ? 'Enter your registered email address to receive a Firebase password reset link.'
                : 'Sign in or create an account with your email and password to receive your permanent CV Player ID and enter live auction rooms.'}
            </p>
          </div>

          {!isFirebaseConfigured && firebaseConfigError && (
            <div className="p-3.5 rounded-lg bg-amber-950/50 border border-amber-700/70 text-xs text-amber-200 flex items-start gap-2.5 break-words">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold text-amber-300">
                  Firebase Web App Keys Required ({firebaseProjectId})
                </div>
                <p>{firebaseConfigError}</p>
              </div>
            </div>
          )}

          {mode !== 'FORGOT_PASSWORD' && (
            <div className="flex p-1 bg-[#060B18] rounded-lg border border-slate-800">
              <button
                type="button"
                onClick={() => switchMode('LOGIN')}
                className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  mode === 'LOGIN'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => switchMode('REGISTER')}
                className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  mode === 'REGISTER'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Create Account
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'REGISTER' && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Username / Franchise Owner Name
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={40}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Vikramaditya Rao"
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#060B18] border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@franchise.com"
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#060B18] border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
              />
            </div>

            {mode !== 'FORGOT_PASSWORD' && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-medium text-slate-300">Password</label>
                  {mode === 'LOGIN' && (
                    <button
                      type="button"
                      onClick={() => switchMode('FORGOT_PASSWORD')}
                      className="text-xs text-amber-400 hover:text-amber-300 cursor-pointer"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#060B18] border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                />
              </div>
            )}

            {mode === 'REGISTER' && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Confirm Password
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#060B18] border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                />
              </div>
            )}

            {errorText && (
              <div className="p-3 rounded-lg bg-red-950/50 border border-red-800/70 text-xs text-red-200 break-words">
                {errorText}
              </div>
            )}

            {resetSentMessage && (
              <div className="p-3 rounded-lg bg-emerald-950/50 border border-emerald-700/70 text-xs text-emerald-200 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>{resetSentMessage}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3.5 px-4 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition-colors disabled:opacity-60 flex items-center justify-center gap-2 cursor-pointer"
            >
              {mode === 'FORGOT_PASSWORD' && <Mail className="w-4 h-4" />}
              <span>
                {submitting
                  ? 'Processing...'
                  : mode === 'LOGIN'
                  ? 'Sign In'
                  : mode === 'REGISTER'
                  ? 'Register & Generate Player ID'
                  : 'Send Password Reset Link'}
              </span>
            </button>

            {mode === 'FORGOT_PASSWORD' && (
              <button
                type="button"
                onClick={() => switchMode('LOGIN')}
                className="w-full py-2 text-xs text-slate-400 hover:text-white flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Sign In</span>
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
};
