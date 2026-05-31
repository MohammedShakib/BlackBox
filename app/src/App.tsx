import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { AuthWizard } from "./components/AuthWizard";
import { Dashboard } from "./components/Dashboard";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UpdateBanner } from "./components/UpdateBanner";
import { WebModeApp } from "./components/WebModeApp";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { checkSupabaseHealth, hasSupabaseEnv } from "./lib/supabase";
import "./App.css";

import { Toaster } from "sonner";
import { ConfirmProvider } from "./context/ConfirmContext";
import { CacheSessionProvider } from "./context/CacheSessionContext";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import { SettingsProvider } from "./context/SettingsContext";
import { DropZoneProvider } from "./contexts/DropZoneContext";

const queryClient = new QueryClient();
const WEB_ADMIN_SESSION_KEY = "blackbox_web_admin_session";


type AuthStatus = "loading" | "authenticated" | "unauthenticated";

function DesktopAppContent() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const { theme } = useTheme();
  const { available, version, downloading, progress, downloadAndInstall, dismissUpdate } = useUpdateCheck();

  // On mount: check for a saved session and auto-restore it.
  // This is the SINGLE source of truth for the initial connection.
  // useTelegramConnection (inside Dashboard) no longer calls cmd_connect on mount.
  useEffect(() => {
    const checkSession = async () => {
      try {
        const store = await load("config.json");
        const savedId = await store.get<string>("api_id");

        if (!savedId) {
          setAuthStatus("unauthenticated");
          return;
        }

        const apiId = parseInt(savedId, 10);
        if (isNaN(apiId)) {
          setAuthStatus("unauthenticated");
          return;
        }

        // Initialize the client with the saved API ID
        await invoke("cmd_connect", { apiId });

        // Verify the session is still valid with Telegram servers
        const ok = await invoke<boolean>("cmd_check_connection");
        if (ok) {
          setAuthStatus("authenticated");
        } else {
          setAuthStatus("unauthenticated");
        }
      } catch (err) {
        console.warn("Session restore failed, showing login:", err);
        // Session file is corrupt or revoked - clean up and show login
        try {
          const store = await load("config.json");
          await store.delete("api_id");
          await store.save();
        } catch {
          // best-effort cleanup
        }
        setAuthStatus("unauthenticated");
      }
    };

    checkSession();
  }, []);

  // Styled splash screen while verifying the session
  if (authStatus === "loading") {
    return (
      <main className="h-screen w-screen flex items-center justify-center bg-blackbox-bg">
        <div className="flex flex-col items-center gap-4 animate-pulse">
          <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/60">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <p className="text-sm text-blackbox-subtext tracking-wide">Restoring session...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="h-screen w-screen text-blackbox-text overflow-hidden selection:bg-blackbox-primary/30 relative">
      <UpdateBanner
        available={available}
        version={version}
        downloading={downloading}
        progress={progress}
        onUpdate={downloadAndInstall}
        onDismiss={dismissUpdate}
      />
      <Toaster theme={theme} position="bottom-center" />
      {authStatus === "authenticated" ? (
        <Dashboard onLogout={() => setAuthStatus("unauthenticated")} />
      ) : (
        <AuthWizard onLogin={() => setAuthStatus("authenticated")} />
      )}
    </main>
  );
}

function WebAppContent() {
  const { theme } = useTheme();
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [adminUsername, setAdminUsername] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminLoginError, setAdminLoginError] = useState("");
  const [supabaseStatus, setSupabaseStatus] = useState<"checking" | "connected" | "error" | "missing">(
    hasSupabaseEnv ? "checking" : "missing",
  );
  const [supabaseMessage, setSupabaseMessage] = useState(
    hasSupabaseEnv ? "Checking Supabase connection..." : "Supabase env missing.",
  );

  useEffect(() => {
    document.body.classList.add("web-runtime");
    if (typeof window !== "undefined") {
      const savedSession = window.sessionStorage.getItem(WEB_ADMIN_SESSION_KEY);
      setIsAdminAuthenticated(savedSession === "1");
    }

    const checkSupabase = async () => {
      const result = await checkSupabaseHealth();
      setSupabaseStatus(result.ok ? "connected" : "error");
      setSupabaseMessage(result.message);
    };

    if (hasSupabaseEnv) {
      checkSupabase();
    }

    return () => {
      document.body.classList.remove("web-runtime");
    };
  }, []);

  const submitAdminLogin = (event: FormEvent) => {
    event.preventDefault();
    setAdminLoginError("");

    if (adminUsername.trim() === "admin" && adminPassword === "admin") {
      setIsAdminAuthenticated(true);
      setShowAdminLogin(false);
      setAdminUsername("");
      setAdminPassword("");
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(WEB_ADMIN_SESSION_KEY, "1");
      }
      return;
    }

    setAdminLoginError("Invalid admin credentials.");
  };

  const logoutAdmin = () => {
    setIsAdminAuthenticated(false);
    setShowAdminLogin(false);
    setAdminUsername("");
    setAdminPassword("");
    setAdminLoginError("");
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(WEB_ADMIN_SESSION_KEY);
    }
  };

  if (isAdminAuthenticated) {
    return (
      <>
        <Toaster theme={theme} position="bottom-center" />
        <div className="fixed top-4 right-4 z-50">
          <button
            type="button"
            onClick={logoutAdmin}
            className="px-3 py-1.5 rounded-lg border border-blackbox-border bg-blackbox-bg/90 text-xs text-blackbox-subtext hover:text-blackbox-text transition-colors backdrop-blur-sm"
          >
            Admin Logout
          </button>
        </div>
        <WebModeApp />
      </>
    );
  }

  return (
    <>
      <Toaster theme={theme} position="bottom-center" />

      <main className="min-h-screen bg-blackbox-bg text-blackbox-text flex flex-col relative overflow-hidden">

        {/* Background decoration */}
        <div className="absolute inset-0 pointer-events-none select-none" aria-hidden>
          <div
            className="absolute inset-0 opacity-[0.25]"
            style={{
              backgroundImage: "radial-gradient(circle, rgba(29,252,159,0.18) 1px, transparent 1px)",
              backgroundSize: "48px 48px",
            }}
          />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[500px] rounded-full bg-blackbox-primary/4 blur-3xl" />
          <div className="absolute -top-40 -right-40 w-[500px] h-[500px] rounded-full bg-blackbox-secondary/8 blur-3xl" />
          <div className="absolute -bottom-40 -left-40 w-[500px] h-[500px] rounded-full bg-blackbox-primary/4 blur-3xl" />
        </div>

        {/* Hero */}
        <div className="flex-1 flex flex-col items-center justify-center px-6 py-20 relative z-10 text-center">

          {/* Icon */}
          <div className="mb-8 w-16 h-16 rounded-3xl bg-blackbox-primary/10 border border-blackbox-primary/20 flex items-center justify-center shadow-xl shadow-blackbox-primary/10">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-blackbox-primary"
            >
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
          </div>

          {/* Wordmark */}
          <h1 className="text-[clamp(3.5rem,10vw,7rem)] font-black tracking-tighter leading-none">
            BlackBox
          </h1>

          {/* Tagline */}
          <p className="mt-5 text-base md:text-lg text-blackbox-subtext/60 max-w-sm leading-relaxed">
            Private file storage, powered by Telegram infrastructure.
          </p>

          {/* Feature pills */}
          <div className="mt-10 flex flex-wrap gap-3 justify-center">
            {(
              [
                ["🔐", "End-to-end private"],
                ["⚡", "Telegram-native"],
                ["🌐", "Web accessible"],
              ] as [string, string][]
            ).map(([icon, label]) => (
              <span
                key={label}
                className="px-4 py-2 rounded-full border border-blackbox-border bg-blackbox-hover text-sm text-blackbox-subtext/80 flex items-center gap-2"
              >
                <span>{icon}</span>
                {label}
              </span>
            ))}
          </div>

          {/* System status */}
          <div className="mt-12 inline-flex items-center gap-2 text-xs text-blackbox-subtext/40 bg-blackbox-hover/60 border border-blackbox-border/40 rounded-full px-3 py-1.5">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                supabaseStatus === "connected"
                  ? "bg-emerald-400"
                  : supabaseStatus === "checking"
                  ? "bg-amber-400 animate-pulse"
                  : "bg-red-400/60"
              }`}
            />
            {supabaseMessage}
          </div>
        </div>

        {/* Footer */}
        <div className="relative z-10 flex items-center justify-between px-8 py-5 border-t border-blackbox-border/15">
          <span className="text-xs text-blackbox-subtext/20">BlackBox © 2025</span>
          <button
            type="button"
            onClick={() => { setShowAdminLogin(true); setAdminLoginError(""); }}
            className="text-xs text-blackbox-subtext/20 hover:text-blackbox-subtext/50 transition-colors"
          >
            Access
          </button>
        </div>

        {/* Admin login modal */}
        {showAdminLogin && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center px-4">
            <div className="w-full max-w-sm rounded-2xl border border-blackbox-border bg-blackbox-surface p-7 shadow-2xl">

              <div className="flex items-center gap-3 mb-6">
                <div className="w-9 h-9 rounded-xl bg-blackbox-primary/10 border border-blackbox-primary/20 flex items-center justify-center flex-shrink-0">
                  <Lock size={15} className="text-blackbox-primary" />
                </div>
                <div>
                  <h2 className="text-sm font-bold">Admin Access</h2>
                  <p className="text-xs text-blackbox-subtext/50 mt-0.5">Control panel credentials</p>
                </div>
              </div>

              <form onSubmit={submitAdminLogin} className="space-y-3">
                <input
                  type="text"
                  value={adminUsername}
                  onChange={(e) => setAdminUsername(e.target.value)}
                  placeholder="Username"
                  autoFocus
                  className="w-full px-3 py-2.5 rounded-xl bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary/40 text-sm"
                />
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="Password"
                  className="w-full px-3 py-2.5 rounded-xl bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary/40 text-sm"
                />

                {adminLoginError && (
                  <p className="text-xs text-red-400 flex items-center gap-1.5">
                    <span className="w-1 h-1 rounded-full bg-red-400 flex-shrink-0" />
                    {adminLoginError}
                  </p>
                )}

                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => { setShowAdminLogin(false); setAdminLoginError(""); }}
                    className="flex-1 px-4 py-2.5 rounded-xl border border-blackbox-border bg-blackbox-bg text-sm hover:border-blackbox-primary/30 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex-1 px-4 py-2.5 rounded-xl bg-blackbox-primary text-blackbox-county-green font-semibold text-sm btn-shine"
                  >
                    Sign In
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

function App() {
  const isBrowserRuntime = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

  if (isBrowserRuntime) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <WebAppContent />
        </ThemeProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ConfirmProvider>
            <CacheSessionProvider>
              <SettingsProvider>
                <DropZoneProvider>
                  <DesktopAppContent />
                </DropZoneProvider>
              </SettingsProvider>
            </CacheSessionProvider>
          </ConfirmProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
