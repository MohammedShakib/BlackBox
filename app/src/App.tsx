import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthWizard } from "./components/AuthWizard";
import { Dashboard } from "./components/Dashboard";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UpdateBanner } from "./components/UpdateBanner";
import { WebModeApp } from "./components/WebModeApp";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
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
        // Session file is corrupt or revoked — clean up and show login
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

  useEffect(() => {
    document.body.classList.add("web-runtime");
    if (typeof window !== "undefined") {
      const savedSession = window.sessionStorage.getItem(WEB_ADMIN_SESSION_KEY);
      setIsAdminAuthenticated(savedSession === "1");
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
      <main className="min-h-screen bg-blackbox-bg text-blackbox-text px-6 py-10 md:px-10 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_15%_20%,rgba(29,252,159,0.12),transparent_45%),radial-gradient(circle_at_85%_15%,rgba(64,165,127,0.2),transparent_40%)]" />

        <div className="relative z-10 max-w-5xl mx-auto">
          <div className="flex justify-end mb-8">
            <button
              type="button"
              onClick={() => {
                setShowAdminLogin(true);
                setAdminLoginError("");
              }}
              className="px-4 py-2 rounded-lg border border-blackbox-border bg-blackbox-bg/90 text-sm font-semibold"
            >
              Admin Control
            </button>
          </div>

          <section className="rounded-3xl border border-blackbox-border bg-blackbox-hover/70 p-8 md:p-12 shadow-2xl">
            <p className="text-xs tracking-[0.28em] text-blackbox-subtext uppercase">Welcome</p>
            <h1 className="mt-3 text-3xl md:text-5xl font-bold leading-tight">Maybe Landing Page</h1>
            <p className="mt-4 text-base md:text-lg text-blackbox-subtext max-w-2xl">
              This is the public entry page. Only admin users can open backend control and manage the full system panel.
            </p>
          </section>
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
