import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Clapperboard,
  Download,
  Film,
  Flame,
  Ghost,
  Home,
  Orbit,
  Search,
  ShieldCheck,
  Tv,
} from "lucide-react";
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

type LandingReleaseItem = {
  id: number;
  title: string;
  meta: string;
  age: string;
  tag: string;
};

const landingReleases: LandingReleaseItem[] = [
  { id: 1, title: "FROM (2026) Dual Audio [Hindi & English]", meta: "Prime Original Web Series", age: "1 hour ago", tag: "WEB-DL" },
  { id: 2, title: "Kattalan (2026) Hindi Dubbed HDTC V2", meta: "720p | 1080p | HEVC", age: "2 days ago", tag: "HDTC" },
  { id: 3, title: "Kara (2026) Dual Audio [Hindi & Tamil]", meta: "WEB-DL 480p | 720p", age: "4 days ago", tag: "WEB-DL" },
  { id: 4, title: "Spider-Noir (2026) Hindi Dubbed", meta: "Amazon Prime Release", age: "4 days ago", tag: "WEB-DL" },
  { id: 5, title: "Bonolota Express (2026) Bengali", meta: "720p | 1080p", age: "1 week ago", tag: "WEB-DL" },
  { id: 6, title: "Bachelor Point (Season 5)", meta: "Bangla Original Web", age: "1 week ago", tag: "WEB-DL" },
  { id: 7, title: "The Prince (2026) Dubbed", meta: "Dual Audio 1080p", age: "9 days ago", tag: "TRENDING" },
  { id: 8, title: "Rakkhosh (2026) Bengali", meta: "Full HD 720p", age: "10 days ago", tag: "WEB-DL" },
];

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
            className="px-3 py-2 rounded-lg border border-blackbox-border bg-blackbox-bg/90 text-sm font-medium"
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
      <main className="min-h-screen bg-[#090913] text-blackbox-text relative overflow-hidden pb-12">
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_18%_8%,rgba(37,130,96,0.22),transparent_42%),radial-gradient(circle_at_84%_6%,rgba(29,252,159,0.12),transparent_30%)]" />

        <div className="relative z-10">
          <header className="border-b border-white/10 bg-black/60 backdrop-blur">
            <div className="mx-auto w-full max-w-[1380px] px-4 py-5 md:px-8">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 md:gap-7">
                  <div className="text-xl font-extrabold tracking-wide text-[#b8ff3e]">
                    CINEFREAK<span className="text-white text-base">.top</span>
                  </div>
                  <nav className="hidden lg:flex items-center gap-6 text-[17px] font-semibold">
                    <a href="#" className="inline-flex items-center gap-2 text-white hover:text-blackbox-primary">
                      <Home size={16} />
                      Home
                    </a>
                    <a href="#" className="inline-flex items-center gap-2 text-white hover:text-blackbox-primary">
                      <Tv size={16} />
                      WEB-Series
                    </a>
                    <a href="#" className="inline-flex items-center gap-2 text-white hover:text-blackbox-primary">
                      <Film size={16} />
                      Movies
                    </a>
                    <a href="#" className="inline-flex items-center gap-2 text-white hover:text-blackbox-primary">
                      <Ghost size={16} />
                      Horror
                    </a>
                    <a href="#" className="inline-flex items-center gap-2 text-white hover:text-blackbox-primary">
                      <Orbit size={16} />
                      MCU
                    </a>
                  </nav>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowAdminLogin(true);
                    setAdminLoginError("");
                  }}
                  className="rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold hover:border-blackbox-primary/40"
                >
                  Admin Control
                </button>
              </div>
            </div>
          </header>

          <div className="mx-auto w-full max-w-[1380px] px-4 pt-5 md:px-8">
            <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-2 rounded-full border border-red-400/35 bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-200">
                  <ShieldCheck size={15} />
                  18+ Movies
                </span>
                <span className="inline-flex items-center rounded-full border border-blue-400/35 bg-blue-500/15 px-4 py-2 text-sm font-semibold text-blue-100">
                  Join Telegram
                </span>
                <span className="inline-flex items-center gap-2 rounded-full border border-yellow-300/30 bg-yellow-500/15 px-4 py-2 text-sm font-semibold text-yellow-100">
                  <Download size={15} />
                  How to Download
                </span>
              </div>
              <div className="hidden md:inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-3 py-2 text-sm text-blackbox-subtext">
                <Search size={16} />
                Search
              </div>
            </div>

            <section className="pt-10">
              <div className="mb-8 flex items-center justify-between gap-4">
                <h1 className="inline-flex items-center gap-3 text-3xl font-bold">
                  <Flame size={24} />
                  Latest Releases
                </h1>
                <div className="text-xs text-blackbox-subtext">
                  {supabaseStatus === "connected"
                    ? `Backend: Connected - ${supabaseMessage}`
                    : `Backend: ${supabaseMessage}`}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {landingReleases.map((item, index) => (
                  <article
                    key={item.id}
                    className="overflow-hidden rounded-xl border border-[#3b2f0f] bg-[#0f0f18] shadow-[0_0_0_1px_rgba(255,184,0,0.08)]"
                  >
                    <div className="relative aspect-[3/4] border-b border-white/10">
                      <div className="absolute inset-0 bg-gradient-to-br from-[#2b5b47] via-[#1e2635] to-[#3d251e]" />
                      <div className="absolute inset-0 opacity-35 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),transparent_45%),linear-gradient(145deg,transparent,rgba(0,0,0,0.55))]" />
                      <span className="absolute left-2 top-2 inline-flex items-center rounded-sm bg-black/60 px-2 py-0.5 text-[10px] font-extrabold tracking-[0.18em] text-white">
                        TRENDING
                      </span>
                      <span className="absolute right-2 top-2 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        {item.tag}
                      </span>
                      <div className="absolute bottom-3 left-3 right-3 text-sm font-bold text-white">
                        #{index + 1} SAMPLE
                      </div>
                    </div>
                    <div className="space-y-2 p-3">
                      <h2 className="max-h-[60px] overflow-hidden text-[15px] font-extrabold leading-5">{item.title}</h2>
                      <p className="max-h-8 overflow-hidden text-xs text-blackbox-subtext">{item.meta}</p>
                      <p className="text-xs text-white/70">{item.age}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>

          <div className="mx-auto w-full max-w-[1380px] px-4 pt-10 md:px-8">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setShowAdminLogin(true);
                  setAdminLoginError("");
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-blackbox-border bg-blackbox-bg/60 px-4 py-2 text-sm font-semibold"
              >
                <Clapperboard size={15} />
                Open Admin Login
              </button>
            </div>
          </div>
        </div>

        {showAdminLogin && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center px-4">
            <div className="w-full max-w-md rounded-2xl border border-blackbox-border bg-blackbox-surface p-6">
              <h2 className="text-xl font-bold">Admin Login</h2>
              <p className="text-sm text-blackbox-subtext mt-1">
                Enter admin credentials to access the control panel.
              </p>

              <form onSubmit={submitAdminLogin} className="mt-4 space-y-3">
                <input
                  type="text"
                  value={adminUsername}
                  onChange={(e) => setAdminUsername(e.target.value)}
                  placeholder="Username"
                  className="w-full px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
                />
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="Password"
                  className="w-full px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
                />
                {adminLoginError && <p className="text-sm text-red-400">{adminLoginError}</p>}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAdminLogin(false)}
                    className="px-4 py-2 rounded-lg border border-blackbox-border bg-blackbox-bg"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-lg bg-blackbox-primary text-blackbox-county-green font-semibold"
                  >
                    Login
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
