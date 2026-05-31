import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  Link2,
  Lock,
  RefreshCw,
  Search,
  Shield,
} from "lucide-react";
import { formatBytes } from "../utils";
import {
  hasSupabaseEnv,
  loadChannelCache,
  loadWebModeSettingsFromSupabase,
  saveChannelCache,
  saveWebModeSettingsToSupabase,
  type CachedFileEntry,
  type WebModeSettingsPayload,
} from "../lib/supabase";

// ── types ──────────────────────────────────────────────────────────────────

type HealthResponse = { status: string; version: string };

type ApiConfigResponse = {
  locked_mode: boolean;
  locked_folder_id: number | null;
  auth_management_requires_admin_key: boolean;
};

type FilesResponse = {
  files: CachedFileEntry[];
  page: number;
  limit: number;
  total: number;
};

type AuthResult = {
  success: boolean;
  next_step?: string;
  error?: string;
};

type AuthStatusResponse = { connected: boolean; authorized: boolean };

type AuthStep = "idle" | "code_sent" | "password_required" | "done";

// ── constants ──────────────────────────────────────────────────────────────

const BASE_URL_KEY = "blackbox_web_api_base_url";
const API_KEY_KEY = "blackbox_web_api_key";
const ADMIN_REMEMBER_KEY = "blackbox_web_admin_remember";
const ADMIN_FORM_KEY = "blackbox_web_admin_form";
const DEFAULT_BASE_URL = "https://blackbox-api-w1iq.onrender.com";

const FALLBACK_CONFIG: ApiConfigResponse = {
  locked_mode: false,
  locked_folder_id: null,
  auth_management_requires_admin_key: false,
};

// ── helpers ────────────────────────────────────────────────────────────────

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function parseFolderId(input: string): number | null {
  const value = input.trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function extractFileName(cd: string | null, fallback: string): string {
  if (!cd) return fallback;
  const utf8 = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) return decodeURIComponent(utf8[1]);
  const plain = cd.match(/filename="([^"]+)"/i);
  return plain?.[1] ?? fallback;
}

async function parseApiError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    const msg = data?.error?.message || data?.error;
    if (typeof msg === "string" && msg.trim()) return msg;
  } catch { /* ignore */ }
  return `Request failed (${res.status})`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function timeAgo(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return "";
  }
}

// ── PasswordInput ──────────────────────────────────────────────────────────

function PasswordInput({
  value,
  onChange,
  placeholder,
  shown,
  onToggle,
  className = "",
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  shown: boolean;
  onToggle: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`relative ${className}`}>
      <input
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full px-3 py-2 pr-10 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary/40 text-sm disabled:opacity-50"
      />
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-blackbox-subtext hover:text-blackbox-text disabled:opacity-50"
        aria-label={shown ? "Hide" : "Show"}
      >
        {shown ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

// ── StepBadge ──────────────────────────────────────────────────────────────

function StepBadge({ n, active, done }: { n: number; active: boolean; done: boolean }) {
  return (
    <span
      className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-colors ${
        done
          ? "bg-emerald-500 text-white"
          : active
          ? "bg-blackbox-primary text-blackbox-county-green"
          : "bg-blackbox-bg border border-blackbox-border text-blackbox-subtext"
      }`}
    >
      {done ? "✓" : n}
    </span>
  );
}

// ── WebModeApp ─────────────────────────────────────────────────────────────

export function WebModeApp() {
  // connection
  const [baseUrlInput, setBaseUrlInput] = useState(DEFAULT_BASE_URL);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionInfo, setConnectionInfo] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [apiConfig, setApiConfig] = useState<ApiConfigResponse | null>(null);

  // admin credentials
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [apiIdInput, setApiIdInput] = useState("");
  const [apiHashInput, setApiHashInput] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [adminKeyInput, setAdminKeyInput] = useState("");
  const [rememberAdminInputs, setRememberAdminInputs] = useState(true);
  const [authStep, setAuthStep] = useState<AuthStep>("idle");
  const [authLoading, setAuthLoading] = useState(false);
  const [authInfo, setAuthInfo] = useState("");
  const [authError, setAuthError] = useState("");

  // visibility toggles
  const [showApiKey, setShowApiKey] = useState(false);
  const [showApiHash, setShowApiHash] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showAdminKey, setShowAdminKey] = useState(false);

  // file browser — folder / search / paging
  const [folderIdInput, setFolderIdInput] = useState("");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(50);
  const [page, setPage] = useState(1);

  // supabase file cache
  const [cachedFiles, setCachedFiles] = useState<CachedFileEntry[]>([]);
  const [cacheSyncedAt, setCacheSyncedAt] = useState<string | null>(null);
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [cacheLoading, setCacheLoading] = useState(false);
  const [cacheError, setCacheError] = useState("");

  // sync
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncTotal, setSyncTotal] = useState(0);
  const [syncError, setSyncError] = useState("");

  // download / view
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [viewingId, setViewingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState("");

  // supabase settings sync
  const [supabaseSyncInfo, setSupabaseSyncInfo] = useState(
    hasSupabaseEnv ? "Syncing settings from Supabase..." : "",
  );
  const [supabaseSyncError, setSupabaseSyncError] = useState("");
  const [remoteHydrated, setRemoteHydrated] = useState(false);
  const hasLoadedRemoteRef = useRef(false);
  const saveDebounceRef = useRef<number | null>(null);

  // ── derived ──────────────────────────────────────────────────────────────

  const normalizedBaseUrl = useMemo(() => normalizeBaseUrl(baseUrlInput), [baseUrlInput]);
  const parsedFolderId = useMemo(() => parseFolderId(folderIdInput), [folderIdInput]);
  const cacheKey = useMemo(
    () => (parsedFolderId !== null ? String(parsedFolderId) : "all"),
    [parsedFolderId],
  );

  const filteredFiles = useMemo(() => {
    if (!search.trim()) return cachedFiles;
    const q = search.toLowerCase();
    return cachedFiles.filter((f) => f.name.toLowerCase().includes(q));
  }, [cachedFiles, search]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredFiles.length / limit)),
    [filteredFiles.length, limit],
  );

  const displayedFiles = useMemo(() => {
    const start = (page - 1) * limit;
    return filteredFiles.slice(start, start + limit);
  }, [filteredFiles, page, limit]);

  const currentSettingsPayload = useMemo<WebModeSettingsPayload>(
    () => ({
      mode: "web_mode",
      baseUrl: normalizedBaseUrl,
      apiKey: apiKeyInput.trim(),
      apiId: apiIdInput.trim(),
      apiHash: apiHashInput.trim(),
      phone: phoneInput.trim(),
      adminKey: adminKeyInput.trim(),
      rememberAdminInputs,
      showAdminPanel,
    }),
    [adminKeyInput, apiHashInput, apiIdInput, apiKeyInput, normalizedBaseUrl, phoneInput, rememberAdminInputs, showAdminPanel],
  );

  // ── effects ───────────────────────────────────────────────────────────────

  // hydrate from localStorage + Supabase on mount
  useEffect(() => {
    const hydrate = async () => {
      const savedUrl = localStorage.getItem(BASE_URL_KEY);
      const savedKey = localStorage.getItem(API_KEY_KEY);
      const savedRemember = localStorage.getItem(ADMIN_REMEMBER_KEY);
      if (savedUrl) setBaseUrlInput(savedUrl);
      if (savedKey) setApiKeyInput(savedKey);
      if (savedRemember !== null) setRememberAdminInputs(savedRemember === "1");

      const savedAdmin = localStorage.getItem(ADMIN_FORM_KEY);
      if (savedAdmin) {
        try {
          const parsed = JSON.parse(savedAdmin) as {
            apiId?: string; apiHash?: string; phone?: string; adminKey?: string;
          };
          if (parsed.apiId) setApiIdInput(parsed.apiId);
          if (parsed.apiHash) setApiHashInput(parsed.apiHash);
          if (parsed.phone) setPhoneInput(parsed.phone);
          if (parsed.adminKey) setAdminKeyInput(parsed.adminKey);
          if (parsed.apiId || parsed.apiHash || parsed.phone || parsed.adminKey) {
            setShowAdminPanel(true);
          }
        } catch { /* ignore */ }
      }

      if (!hasSupabaseEnv) {
        hasLoadedRemoteRef.current = true;
        setRemoteHydrated(true);
        setSupabaseSyncInfo("");
        return;
      }

      const { data, error } = await loadWebModeSettingsFromSupabase();
      hasLoadedRemoteRef.current = true;
      setRemoteHydrated(true);

      if (error) {
        setSupabaseSyncError(`Supabase sync error: ${error}`);
        setSupabaseSyncInfo("");
        return;
      }
      if (!data) {
        setSupabaseSyncInfo("Supabase: no saved settings yet.");
        return;
      }

      setBaseUrlInput(data.baseUrl || DEFAULT_BASE_URL);
      setApiKeyInput(data.apiKey);
      setApiIdInput(data.apiId);
      setApiHashInput(data.apiHash);
      setPhoneInput(data.phone);
      setAdminKeyInput(data.adminKey);
      setRememberAdminInputs(data.rememberAdminInputs);
      setShowAdminPanel(data.showAdminPanel);
      setSupabaseSyncInfo("Supabase: settings loaded.");
    };

    hydrate();
  }, []);

  // persist admin form to localStorage
  useEffect(() => {
    localStorage.setItem(ADMIN_REMEMBER_KEY, rememberAdminInputs ? "1" : "0");
    if (rememberAdminInputs) {
      localStorage.setItem(
        ADMIN_FORM_KEY,
        JSON.stringify({
          apiId: apiIdInput.trim(),
          apiHash: apiHashInput.trim(),
          phone: phoneInput.trim(),
          adminKey: adminKeyInput.trim(),
        }),
      );
    } else {
      localStorage.removeItem(ADMIN_FORM_KEY);
    }
  }, [rememberAdminInputs, apiIdInput, apiHashInput, phoneInput, adminKeyInput]);

  // debounce-save settings to Supabase
  useEffect(() => {
    if (!remoteHydrated || !hasLoadedRemoteRef.current || !hasSupabaseEnv) return;

    if (saveDebounceRef.current) window.clearTimeout(saveDebounceRef.current);
    setSupabaseSyncError("");
    setSupabaseSyncInfo("Supabase: saving…");

    saveDebounceRef.current = window.setTimeout(async () => {
      const { error } = await saveWebModeSettingsToSupabase(currentSettingsPayload);
      if (error) {
        setSupabaseSyncError(`Supabase sync error: ${error}`);
        setSupabaseSyncInfo("");
      } else {
        setSupabaseSyncInfo("Supabase: settings synced.");
      }
    }, 700);

    return () => { if (saveDebounceRef.current) window.clearTimeout(saveDebounceRef.current); };
  }, [currentSettingsPayload, remoteHydrated]);

  // load cache whenever cacheKey changes
  useEffect(() => {
    if (!hasSupabaseEnv) return;

    let cancelled = false;
    setCacheLoaded(false);
    setCacheLoading(true);
    setCachedFiles([]);
    setCacheSyncedAt(null);
    setCacheError("");
    setPage(1);

    loadChannelCache(cacheKey).then(({ data, error }) => {
      if (cancelled) return;
      setCacheLoading(false);
      if (error) { setCacheError(error); return; }
      if (!data) return;
      setCachedFiles(data.files);
      setCacheSyncedAt(data.synced_at);
      setCacheLoaded(true);
    });

    return () => { cancelled = true; };
  }, [cacheKey]);

  // reset page when search or limit changes
  useEffect(() => { setPage(1); }, [search, limit]);

  // ── api helpers ───────────────────────────────────────────────────────────

  const fetchConfig = async (): Promise<ApiConfigResponse> => {
    const res = await fetch(`${normalizedBaseUrl}/api/v1/config`);
    if (res.status === 404) return FALLBACK_CONFIG;
    if (!res.ok) throw new Error(await parseApiError(res));
    try { return await res.json(); } catch { return FALLBACK_CONFIG; }
  };

  const postAuth = async (path: string, payload: Record<string, unknown>) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (adminKeyInput.trim()) headers["X-Admin-Key"] = adminKeyInput.trim();
    const res = await fetch(`${normalizedBaseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const data: AuthResult = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };

  // ── connect / disconnect ──────────────────────────────────────────────────

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setConnectionError("");
    setConnectionInfo("");
    if (!normalizedBaseUrl) { setConnectionError("API base URL is required."); return; }
    if (!apiKeyInput.trim()) { setConnectionError("API key is required."); return; }

    setConnecting(true);
    try {
      const healthRes = await fetch(`${normalizedBaseUrl}/api/v1/health`);
      if (!healthRes.ok) throw new Error(await parseApiError(healthRes));
      const health: HealthResponse = await healthRes.json();

      const cfg = await fetchConfig();
      setApiConfig(cfg);

      const testRes = await fetch(`${normalizedBaseUrl}/api/v1/files?page=1&limit=1`, {
        headers: { "X-API-Key": apiKeyInput.trim() },
      });
      if (!testRes.ok) {
        if (testRes.status === 401) throw new Error("Invalid API key.");
        if (testRes.status === 503) throw new Error("Backend connected, but Telegram session is not logged in yet.");
        throw new Error(await parseApiError(testRes));
      }

      localStorage.setItem(BASE_URL_KEY, normalizedBaseUrl);
      localStorage.setItem(API_KEY_KEY, apiKeyInput.trim());

      setConnected(true);
      const lockLabel = cfg.locked_mode
        ? `Locked channel (folder: ${cfg.locked_folder_id ?? "hidden"}).`
        : "Unlocked mode.";
      setConnectionInfo(`Connected · ${health.status} v${health.version} · ${lockLabel}`);
    } catch (err) {
      setConnected(false);
      setConnectionError(err instanceof Error ? err.message : "Failed to connect.");
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = () => {
    setConnected(false);
    setConnectionInfo("Disconnected.");
    setConnectionError("");
    setApiConfig(null);
    setAuthStep("idle");
    setAuthInfo("");
    setAuthError("");
  };

  // ── auth actions ──────────────────────────────────────────────────────────

  const requestCode = async () => {
    setAuthError("");
    setAuthInfo("");
    if (!apiIdInput.trim() || !apiHashInput.trim() || !phoneInput.trim()) {
      setAuthError("API ID, API hash, and phone are required.");
      return;
    }
    const parsedApiId = Number(apiIdInput.trim());
    if (!Number.isInteger(parsedApiId)) { setAuthError("API ID must be an integer."); return; }
    if (apiConfig?.auth_management_requires_admin_key && !adminKeyInput.trim()) {
      setAuthError("Admin key is required for auth actions.");
      return;
    }
    setAuthLoading(true);
    try {
      const data = await postAuth("/api/v1/auth/request_code", {
        api_id: parsedApiId,
        api_hash: apiHashInput.trim(),
        phone: phoneInput.trim(),
      });
      setAuthStep("code_sent");
      setAuthInfo(`Code sent. Next: ${data.next_step ?? "enter code"}.`);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Failed to request code.");
    } finally {
      setAuthLoading(false);
    }
  };

  const signInWithCode = async () => {
    setAuthError("");
    setAuthInfo("");
    if (!codeInput.trim()) { setAuthError("Verification code is required."); return; }
    if (apiConfig?.auth_management_requires_admin_key && !adminKeyInput.trim()) {
      setAuthError("Admin key is required for auth actions.");
      return;
    }
    setAuthLoading(true);
    try {
      const data = await postAuth("/api/v1/auth/sign_in", { code: codeInput.trim() });
      if (data.next_step === "password") {
        setAuthStep("password_required");
        setAuthInfo("2FA password required.");
      } else {
        setAuthStep("done");
        setAuthInfo("Login successful.");
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Failed to sign in.");
    } finally {
      setAuthLoading(false);
    }
  };

  const submitPassword = async () => {
    setAuthError("");
    setAuthInfo("");
    if (!passwordInput.trim()) { setAuthError("Password is required."); return; }
    if (apiConfig?.auth_management_requires_admin_key && !adminKeyInput.trim()) {
      setAuthError("Admin key is required for auth actions.");
      return;
    }
    setAuthLoading(true);
    try {
      await postAuth("/api/v1/auth/check_password", { password: passwordInput });
      setAuthStep("done");
      setAuthInfo("Password accepted. Login successful.");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Failed to verify password.");
    } finally {
      setAuthLoading(false);
    }
  };

  const checkAuthStatus = async () => {
    setAuthError("");
    setAuthInfo("");
    try {
      const headers: Record<string, string> = {};
      if (adminKeyInput.trim()) headers["X-Admin-Key"] = adminKeyInput.trim();
      const res = await fetch(`${normalizedBaseUrl}/api/v1/auth/status`, { headers });
      if (!res.ok) throw new Error(await parseApiError(res));
      const data: AuthStatusResponse = await res.json();
      setAuthInfo(`Status: connected=${data.connected}, authorized=${data.authorized}`);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Failed to check status.");
    }
  };

  // ── sync all files ────────────────────────────────────────────────────────

  const syncAllFiles = async () => {
    if (!connected || !normalizedBaseUrl || !apiKeyInput.trim()) {
      setSyncError("Connect to the API before syncing.");
      return;
    }
    setIsSyncing(true);
    setSyncProgress(0);
    setSyncTotal(0);
    setSyncError("");

    const makeParams = (p: number) => {
      const params = new URLSearchParams({ page: String(p), limit: "200" });
      if (!apiConfig?.locked_mode && parsedFolderId !== null) {
        params.set("folder_id", String(parsedFolderId));
      }
      return params;
    };

    const fetchPage = async (p: number): Promise<FilesResponse> => {
      const res = await fetch(`${normalizedBaseUrl}/api/v1/files?${makeParams(p)}`, {
        headers: { "X-API-Key": apiKeyInput.trim() },
      });
      if (!res.ok) throw new Error(await parseApiError(res));
      return res.json();
    };

    try {
      const first = await fetchPage(1);
      setSyncTotal(first.total);
      const allFiles: CachedFileEntry[] = [...first.files];
      setSyncProgress(allFiles.length);

      const numPages = Math.ceil(first.total / 200);
      for (let batchStart = 2; batchStart <= numPages; batchStart += 8) {
        const batchEnd = Math.min(batchStart + 7, numPages);
        const batch = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) =>
          fetchPage(batchStart + i),
        );
        const results = await Promise.all(batch);
        for (const r of results) allFiles.push(...r.files);
        setSyncProgress(allFiles.length);
      }

      const { error: saveErr } = await saveChannelCache(cacheKey, allFiles, first.total);
      if (saveErr) setSyncError(`Sync complete but cache save failed: ${saveErr}`);

      setCachedFiles(allFiles);
      setCacheSyncedAt(new Date().toISOString());
      setCacheLoaded(true);
      setPage(1);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setIsSyncing(false);
      setSyncProgress(0);
      setSyncTotal(0);
    }
  };

  // ── file actions ──────────────────────────────────────────────────────────

  const buildFileUrl = (fileId: number) => {
    const params = new URLSearchParams();
    if (!apiConfig?.locked_mode && parsedFolderId !== null) {
      params.set("folder_id", String(parsedFolderId));
    }
    const qs = params.toString();
    return `${normalizedBaseUrl}/api/v1/files/${fileId}/download${qs ? `?${qs}` : ""}`;
  };

  const fetchFileBlob = async (fileId: number) => {
    const res = await fetch(buildFileUrl(fileId), {
      headers: { "X-API-Key": apiKeyInput.trim() },
    });
    if (!res.ok) throw new Error(await parseApiError(res));
    return { blob: await res.blob(), cd: res.headers.get("content-disposition") };
  };

  const downloadFile = async (file: CachedFileEntry) => {
    if (!normalizedBaseUrl || !apiKeyInput.trim()) {
      setActionError("Connect to API to download files.");
      return;
    }
    setDownloadingId(file.id);
    setActionError("");
    try {
      const { blob, cd } = await fetchFileBlob(file.id);
      const objectUrl = URL.createObjectURL(blob);
      const name = extractFileName(cd, file.name);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setDownloadingId(null);
    }
  };

  const viewFile = async (file: CachedFileEntry) => {
    if (!normalizedBaseUrl || !apiKeyInput.trim()) {
      setActionError("Connect to API to view files.");
      return;
    }
    setViewingId(file.id);
    setActionError("");
    try {
      const { blob } = await fetchFileBlob(file.id);
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, "_blank");
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "View failed.");
    } finally {
      setViewingId(null);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────

  const inputCls =
    "w-full px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary/40 text-sm";

  const primaryBtn =
    "px-4 py-2 rounded-lg bg-blackbox-primary text-blackbox-county-green font-semibold text-sm disabled:opacity-50 transition-opacity";

  const ghostBtn =
    "px-4 py-2 rounded-lg border border-blackbox-border bg-blackbox-bg text-sm disabled:opacity-50 hover:border-blackbox-primary/30 transition-colors";

  return (
    <main className="min-h-screen bg-blackbox-bg text-blackbox-text p-4 md:p-8">
      <div className="max-w-5xl mx-auto space-y-4">

        {/* ── Connection ── */}
        <section className="rounded-2xl border border-blackbox-border bg-gradient-to-br from-blackbox-hover to-blackbox-bg p-5 shadow-lg">
          <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
            <div>
              <h1 className="text-xl font-bold flex items-center gap-2">
                <Link2 size={18} className="text-blackbox-primary" />
                BlackBox Web Mode
              </h1>
              <p className="text-xs text-blackbox-subtext mt-0.5">
                Connect your hosted backend API, then browse and download files.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-400" : "bg-blackbox-subtext/30"}`}
              />
              <span className="text-xs text-blackbox-subtext">
                {connected ? "Connected" : "Disconnected"}
              </span>
              {apiConfig?.locked_mode && (
                <span className="ml-2 px-2 py-1 rounded-full text-xs font-semibold bg-blackbox-primary/15 border border-blackbox-primary/30 text-blackbox-primary flex items-center gap-1">
                  <Lock size={11} /> Locked
                </span>
              )}
            </div>
          </div>

          <form onSubmit={connect} className="grid gap-3 md:grid-cols-[1.2fr_1fr_auto]">
            <div className="relative">
              <input
                type="url"
                value={baseUrlInput}
                onChange={(e) => setBaseUrlInput(e.target.value)}
                placeholder="https://your-api.example.com"
                className={`${inputCls} pl-9`}
              />
              <Link2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-blackbox-subtext" />
            </div>
            <PasswordInput
              value={apiKeyInput}
              onChange={setApiKeyInput}
              placeholder="X-API-Key"
              shown={showApiKey}
              onToggle={() => setShowApiKey((v) => !v)}
            />
            <div className="flex gap-2">
              <button type="submit" disabled={connecting} className={primaryBtn}>
                {connecting ? "Connecting…" : "Connect"}
              </button>
              <button type="button" onClick={disconnect} className={ghostBtn}>
                Disconnect
              </button>
            </div>
          </form>

          <div className="mt-3 space-y-1">
            {connectionInfo && <p className="text-xs text-emerald-400">{connectionInfo}</p>}
            {connectionError && <p className="text-xs text-red-400">{connectionError}</p>}
            {supabaseSyncInfo && <p className="text-xs text-blackbox-subtext/50">{supabaseSyncInfo}</p>}
            {supabaseSyncError && <p className="text-xs text-red-300">{supabaseSyncError}</p>}
          </div>
        </section>

        {/* ── Admin Controls ── */}
        <section className="rounded-2xl border border-blackbox-border bg-blackbox-hover/40 p-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <Shield size={16} className="text-blackbox-primary" />
              <h2 className="text-base font-bold">Admin Controls</h2>
              <span className="text-xs text-blackbox-subtext/50">Telegram login & auth management</span>
            </div>
            <button
              type="button"
              onClick={() => setShowAdminPanel((v) => !v)}
              className={ghostBtn}
            >
              {showAdminPanel ? "Hide" : "Show"} Panel
            </button>
          </div>

          {showAdminPanel && (
            <div className="mt-4 space-y-3">

              {/* Step 1 */}
              <div
                className={`rounded-xl border p-4 transition-colors ${
                  authStep === "idle"
                    ? "border-blackbox-primary/30 bg-blackbox-primary/5"
                    : "border-blackbox-border"
                }`}
              >
                <div className="flex items-center gap-2 mb-3">
                  <StepBadge n={1} active={authStep === "idle"} done={authStep !== "idle"} />
                  <span className="text-xs font-semibold text-blackbox-subtext uppercase tracking-wider">
                    Telegram Credentials
                  </span>
                </div>
                <div className="grid gap-2 md:grid-cols-3">
                  <input
                    type="text"
                    value={apiIdInput}
                    onChange={(e) => setApiIdInput(e.target.value)}
                    placeholder="API ID"
                    disabled={authStep !== "idle"}
                    className={inputCls}
                  />
                  <PasswordInput
                    value={apiHashInput}
                    onChange={setApiHashInput}
                    placeholder="API Hash"
                    shown={showApiHash}
                    onToggle={() => setShowApiHash((v) => !v)}
                    disabled={authStep !== "idle"}
                  />
                  <input
                    type="text"
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    placeholder="Phone (+880…)"
                    disabled={authStep !== "idle"}
                    className={inputCls}
                  />
                </div>
                {authStep === "idle" && (
                  <button
                    type="button"
                    onClick={requestCode}
                    disabled={authLoading}
                    className={`${primaryBtn} mt-3`}
                  >
                    {authLoading ? "Requesting…" : "Request Code →"}
                  </button>
                )}
              </div>

              {/* Step 2 */}
              {authStep !== "idle" && (
                <div
                  className={`rounded-xl border p-4 transition-colors ${
                    authStep === "code_sent"
                      ? "border-blackbox-primary/30 bg-blackbox-primary/5"
                      : "border-blackbox-border"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <StepBadge
                      n={2}
                      active={authStep === "code_sent"}
                      done={authStep === "password_required" || authStep === "done"}
                    />
                    <span className="text-xs font-semibold text-blackbox-subtext uppercase tracking-wider">
                      Verification Code
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={codeInput}
                      onChange={(e) => setCodeInput(e.target.value)}
                      placeholder="Code from Telegram"
                      disabled={authStep !== "code_sent"}
                      className={`${inputCls} flex-1`}
                    />
                    {authStep === "code_sent" && (
                      <button
                        type="button"
                        onClick={signInWithCode}
                        disabled={authLoading}
                        className={primaryBtn}
                      >
                        {authLoading ? "Signing in…" : "Sign In →"}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Step 3 */}
              {(authStep === "password_required" || authStep === "done") && (
                <div
                  className={`rounded-xl border p-4 transition-colors ${
                    authStep === "password_required"
                      ? "border-blackbox-primary/30 bg-blackbox-primary/5"
                      : "border-blackbox-border"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <StepBadge
                      n={3}
                      active={authStep === "password_required"}
                      done={authStep === "done"}
                    />
                    <span className="text-xs font-semibold text-blackbox-subtext uppercase tracking-wider">
                      Two-Factor Password
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <PasswordInput
                      value={passwordInput}
                      onChange={setPasswordInput}
                      placeholder="Telegram 2FA password"
                      shown={showPassword}
                      onToggle={() => setShowPassword((v) => !v)}
                      disabled={authStep !== "password_required"}
                      className="flex-1"
                    />
                    {authStep === "password_required" && (
                      <button
                        type="button"
                        onClick={submitPassword}
                        disabled={authLoading}
                        className={primaryBtn}
                      >
                        {authLoading ? "Confirming…" : "Confirm →"}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Done state */}
              {authStep === "done" && (
                <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 flex items-center gap-3">
                  <CheckCircle2 size={16} className="text-emerald-400 flex-shrink-0" />
                  <p className="text-sm text-emerald-400 flex-1">Telegram authentication complete.</p>
                  <button
                    type="button"
                    onClick={() => { setAuthStep("idle"); setAuthInfo(""); setAuthError(""); }}
                    className="text-xs text-blackbox-subtext hover:text-blackbox-text transition-colors"
                  >
                    Reset
                  </button>
                </div>
              )}

              {/* Admin key + check status */}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <PasswordInput
                  value={adminKeyInput}
                  onChange={setAdminKeyInput}
                  placeholder="Admin key (required for restricted actions)"
                  shown={showAdminKey}
                  onToggle={() => setShowAdminKey((v) => !v)}
                  className="flex-1 min-w-48"
                />
                <button type="button" onClick={checkAuthStatus} className={ghostBtn}>
                  Check Status
                </button>
              </div>

              <label className="flex items-center gap-2 text-sm text-blackbox-subtext cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={rememberAdminInputs}
                  onChange={(e) => setRememberAdminInputs(e.target.checked)}
                  className="h-4 w-4 rounded border-blackbox-border bg-blackbox-bg accent-blackbox-primary"
                />
                Remember API ID, hash, phone and admin key on this browser
              </label>
              <p className="text-xs text-blackbox-subtext/40 -mt-1">
                Verification code and 2FA password are never saved.
              </p>

              {authInfo && <p className="text-sm text-emerald-400">{authInfo}</p>}
              {authError && <p className="text-sm text-red-400">{authError}</p>}
            </div>
          )}
        </section>

        {/* ── File Browser ── */}
        <section className="rounded-2xl border border-blackbox-border bg-blackbox-hover/40 p-5 space-y-4">

          {/* toolbar */}
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-40">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search files…"
                className={`${inputCls} pl-9`}
              />
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-blackbox-subtext" />
            </div>

            {apiConfig?.locked_mode ? (
              <div className="px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border text-xs text-blackbox-subtext flex items-center gap-1.5">
                <Lock size={12} /> Locked channel
              </div>
            ) : (
              <input
                value={folderIdInput}
                onChange={(e) => { setFolderIdInput(e.target.value); }}
                placeholder="Channel / Folder ID"
                className={`${inputCls} w-48`}
              />
            )}

            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className={`${inputCls} w-32`}
            >
              <option value={25}>25 / page</option>
              <option value={50}>50 / page</option>
              <option value={100}>100 / page</option>
              <option value={200}>200 / page</option>
            </select>
          </div>

          {/* cache status + sync */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 text-xs flex-wrap">
              {cacheLoading ? (
                <span className="text-blackbox-subtext/60 flex items-center gap-1.5">
                  <RefreshCw size={12} className="animate-spin" /> Loading cache…
                </span>
              ) : cacheLoaded ? (
                <>
                  <span className="text-blackbox-subtext/80">
                    {filteredFiles.length.toLocaleString()}
                    {search ? " results" : " files cached"}
                  </span>
                  {cacheSyncedAt && (
                    <span className="text-blackbox-subtext/40 flex items-center gap-1">
                      <RefreshCw size={10} />
                      synced {timeAgo(cacheSyncedAt)}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-blackbox-subtext/40">
                  {hasSupabaseEnv
                    ? "No cache for this channel. Connect and click Sync."
                    : "Supabase not configured — cache unavailable."}
                </span>
              )}
              {cacheError && <span className="text-red-400">{cacheError}</span>}
            </div>

            <button
              type="button"
              onClick={syncAllFiles}
              disabled={isSyncing || !connected}
              title={connected ? "Fetch all files from Telegram and update cache" : "Connect to API first"}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blackbox-primary/10 border border-blackbox-primary/20 text-blackbox-primary text-xs font-semibold disabled:opacity-40 hover:bg-blackbox-primary/20 transition-colors whitespace-nowrap"
            >
              <RefreshCw size={13} className={isSyncing ? "animate-spin" : ""} />
              {isSyncing
                ? syncTotal > 0
                  ? `${syncProgress.toLocaleString()} / ${syncTotal.toLocaleString()}`
                  : "Syncing…"
                : "Sync"}
            </button>
          </div>

          {/* sync progress bar */}
          {isSyncing && syncTotal > 0 && (
            <div className="h-1 w-full bg-blackbox-bg rounded-full overflow-hidden">
              <div
                className="h-full bg-blackbox-primary rounded-full transition-all duration-300"
                style={{ width: `${Math.min(100, (syncProgress / syncTotal) * 100)}%` }}
              />
            </div>
          )}

          {(syncError || actionError) && (
            <p className="text-xs text-red-400">{syncError || actionError}</p>
          )}

          {/* table */}
          <div className="overflow-auto border border-blackbox-border rounded-xl">
            <table className="w-full text-sm">
              <thead className="bg-blackbox-bg">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-blackbox-subtext uppercase tracking-wider">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-blackbox-subtext uppercase tracking-wider">Size</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-blackbox-subtext uppercase tracking-wider">Created</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-blackbox-subtext uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody>
                {!cacheLoaded && !cacheLoading ? (
                  <tr>
                    <td className="px-4 py-10 text-blackbox-subtext/40 text-center text-sm" colSpan={4}>
                      {connected
                        ? "Click Sync to load files into cache."
                        : "Connect to API and click Sync to load files."}
                    </td>
                  </tr>
                ) : cacheLoading ? (
                  <tr>
                    <td className="px-4 py-10 text-blackbox-subtext/40 text-center" colSpan={4}>
                      Loading…
                    </td>
                  </tr>
                ) : displayedFiles.length === 0 ? (
                  <tr>
                    <td className="px-4 py-10 text-blackbox-subtext/40 text-center" colSpan={4}>
                      {search ? "No files match your search." : "No files found."}
                    </td>
                  </tr>
                ) : (
                  displayedFiles.map((file) => (
                    <tr
                      key={file.id}
                      className="border-t border-blackbox-border hover:bg-blackbox-primary/5 transition-colors"
                    >
                      <td className="px-4 py-3 max-w-xs truncate font-medium" title={file.name}>
                        {file.name}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-blackbox-subtext whitespace-nowrap">
                        {formatBytes(file.size)}
                      </td>
                      <td className="px-4 py-3 text-blackbox-subtext whitespace-nowrap text-xs">
                        {formatDate(file.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => viewFile(file)}
                            disabled={viewingId === file.id || downloadingId === file.id}
                            className="px-3 py-1.5 rounded-md border border-blackbox-border bg-blackbox-bg hover:border-blackbox-primary/40 disabled:opacity-50 flex items-center gap-1.5 text-xs whitespace-nowrap transition-colors"
                          >
                            <Eye size={12} />
                            {viewingId === file.id ? "Loading…" : "View"}
                          </button>
                          <button
                            onClick={() => downloadFile(file)}
                            disabled={downloadingId === file.id || viewingId === file.id}
                            className="px-3 py-1.5 rounded-md bg-blackbox-primary text-blackbox-county-green disabled:opacity-50 flex items-center gap-1.5 text-xs whitespace-nowrap font-semibold transition-opacity"
                          >
                            <Download size={12} />
                            {downloadingId === file.id ? "…" : "Download"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* pagination */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className={`${ghostBtn} text-xs px-3 py-1.5`}
            >
              ← Previous
            </button>
            <span className="text-xs text-blackbox-subtext">
              Page {page} / {totalPages}
              {filteredFiles.length > 0 && (
                <span className="ml-2 text-blackbox-subtext/40">
                  ({filteredFiles.length.toLocaleString()} files)
                </span>
              )}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className={`${ghostBtn} text-xs px-3 py-1.5`}
            >
              Next →
            </button>
          </div>
        </section>

      </div>
    </main>
  );
}
