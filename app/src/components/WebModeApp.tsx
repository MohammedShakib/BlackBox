import { FormEvent, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Shield, Lock, Link2, Search, Download } from "lucide-react";
import { formatBytes } from "../utils";

type HealthResponse = {
  status: string;
  version: string;
};

type ApiConfigResponse = {
  locked_mode: boolean;
  locked_folder_id: number | null;
  auth_management_requires_admin_key: boolean;
};

type ApiFile = {
  id: number;
  folder_id: number | null;
  name: string;
  size: number;
  mime_type?: string | null;
  created_at: string;
};

type FilesResponse = {
  files: ApiFile[];
  page: number;
  limit: number;
  total: number;
};

type AuthResult = {
  success: boolean;
  next_step?: string;
  error?: string;
};

type AuthStatusResponse = {
  connected: boolean;
  authorized: boolean;
};

const BASE_URL_KEY = "blackbox_web_api_base_url";
const API_KEY_KEY = "blackbox_web_api_key";
const FALLBACK_CONFIG: ApiConfigResponse = {
  locked_mode: false,
  locked_folder_id: null,
  auth_management_requires_admin_key: false,
};

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function parseFolderId(input: string): number | null {
  const value = input.trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function extractFileName(contentDisposition: string | null, fallback: string): string {
  if (!contentDisposition) return fallback;
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);
  const plainMatch = contentDisposition.match(/filename="([^"]+)"/i);
  return plainMatch?.[1] ?? fallback;
}

async function parseApiError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    const message = data?.error?.message || data?.error;
    if (typeof message === "string" && message.trim()) return message;
  } catch {
    // ignore json parse errors
  }
  return `Request failed (${res.status})`;
}

function PasswordInput({
  value,
  onChange,
  placeholder,
  shown,
  onToggle,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  shown: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="relative">
      <input
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 pr-10 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
      />
      <button
        type="button"
        onClick={onToggle}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-blackbox-hover"
        aria-label={shown ? "Hide value" : "Show value"}
      >
        {shown ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

export function WebModeApp() {
  const [baseUrlInput, setBaseUrlInput] = useState("https://blackbox-api-w1iq.onrender.com");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiIdInput, setApiIdInput] = useState("");
  const [apiHashInput, setApiHashInput] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [adminKeyInput, setAdminKeyInput] = useState("");

  const [showApiKey, setShowApiKey] = useState(false);
  const [showApiHash, setShowApiHash] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showAdminKey, setShowAdminKey] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionInfo, setConnectionInfo] = useState("");
  const [connectionError, setConnectionError] = useState("");

  const [authLoading, setAuthLoading] = useState(false);
  const [authInfo, setAuthInfo] = useState("");
  const [authError, setAuthError] = useState("");

  const [search, setSearch] = useState("");
  const [folderIdInput, setFolderIdInput] = useState("");
  const [limit, setLimit] = useState(50);
  const [page, setPage] = useState(1);

  const [files, setFiles] = useState<ApiFile[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const [apiConfig, setApiConfig] = useState<ApiConfigResponse | null>(null);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / limit)), [total, limit]);
  const normalizedBaseUrl = useMemo(() => normalizeBaseUrl(baseUrlInput), [baseUrlInput]);
  const parsedFolderId = useMemo(() => parseFolderId(folderIdInput), [folderIdInput]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedBaseUrl = localStorage.getItem(BASE_URL_KEY);
    const savedApiKey = localStorage.getItem(API_KEY_KEY);
    if (savedBaseUrl) setBaseUrlInput(savedBaseUrl);
    if (savedApiKey) setApiKeyInput(savedApiKey);
  }, []);

  const fetchConfig = async (): Promise<ApiConfigResponse> => {
    const res = await fetch(`${normalizedBaseUrl}/api/v1/config`);
    if (res.status === 404) {
      // Backward-compatible with older backend versions without /api/v1/config
      return FALLBACK_CONFIG;
    }
    if (!res.ok) throw new Error(await parseApiError(res));
    try {
      return (await res.json()) as ApiConfigResponse;
    } catch {
      return FALLBACK_CONFIG;
    }
  };

  const postAuth = async (path: string, payload: Record<string, unknown>) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (adminKeyInput.trim()) {
      headers["X-Admin-Key"] = adminKeyInput.trim();
    }

    const res = await fetch(`${normalizedBaseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const data: AuthResult = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  };

  const requestCode = async () => {
    setAuthError("");
    setAuthInfo("");

    if (!apiIdInput.trim() || !apiHashInput.trim() || !phoneInput.trim()) {
      setAuthError("API ID, API hash, and phone are required for login.");
      return;
    }

    const parsedApiId = Number(apiIdInput.trim());
    if (!Number.isInteger(parsedApiId)) {
      setAuthError("API ID must be an integer.");
      return;
    }

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
      setAuthInfo(`Code requested successfully. Next step: ${data.next_step || "code"}.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to request login code.";
      setAuthError(message);
    } finally {
      setAuthLoading(false);
    }
  };

  const signInWithCode = async () => {
    setAuthError("");
    setAuthInfo("");

    if (!codeInput.trim()) {
      setAuthError("Verification code is required.");
      return;
    }

    if (apiConfig?.auth_management_requires_admin_key && !adminKeyInput.trim()) {
      setAuthError("Admin key is required for auth actions.");
      return;
    }

    setAuthLoading(true);
    try {
      const data = await postAuth("/api/v1/auth/sign_in", {
        code: codeInput.trim(),
      });
      if (data.next_step === "password") {
        setAuthInfo("Password required. Enter your Telegram 2FA password.");
      } else {
        setAuthInfo("Login successful.");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to sign in.";
      setAuthError(message);
    } finally {
      setAuthLoading(false);
    }
  };

  const submitPassword = async () => {
    setAuthError("");
    setAuthInfo("");

    if (!passwordInput.trim()) {
      setAuthError("Password is required.");
      return;
    }

    if (apiConfig?.auth_management_requires_admin_key && !adminKeyInput.trim()) {
      setAuthError("Admin key is required for auth actions.");
      return;
    }

    setAuthLoading(true);
    try {
      await postAuth("/api/v1/auth/check_password", {
        password: passwordInput,
      });
      setAuthInfo("Password accepted. Login successful.");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to verify password.";
      setAuthError(message);
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
      setAuthInfo(`Auth status: connected=${data.connected}, authorized=${data.authorized}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to check auth status.";
      setAuthError(message);
    }
  };

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setConnectionError("");
    setConnectionInfo("");

    if (!normalizedBaseUrl) {
      setConnectionError("API base URL is required.");
      return;
    }
    if (!apiKeyInput.trim()) {
      setConnectionError("API key is required.");
      return;
    }

    setConnecting(true);
    try {
      const healthRes = await fetch(`${normalizedBaseUrl}/api/v1/health`);
      if (!healthRes.ok) throw new Error(await parseApiError(healthRes));
      const health: HealthResponse = await healthRes.json();

      const cfg = await fetchConfig();
      setApiConfig(cfg);

      const testFilesRes = await fetch(`${normalizedBaseUrl}/api/v1/files?page=1&limit=1`, {
        headers: {
          "X-API-Key": apiKeyInput.trim(),
        },
      });
      if (!testFilesRes.ok) {
        if (testFilesRes.status === 401) {
          throw new Error("Invalid API key.");
        }
        if (testFilesRes.status === 503) {
          throw new Error("Backend connected, but Telegram session is not logged in yet.");
        }
        throw new Error(await parseApiError(testFilesRes));
      }

      if (typeof window !== "undefined") {
        localStorage.setItem(BASE_URL_KEY, normalizedBaseUrl);
        localStorage.setItem(API_KEY_KEY, apiKeyInput.trim());
      }

      setConnected(true);
      setPage(1);

      const lockLabel = cfg.locked_mode
        ? `Locked channel mode enabled (folder: ${cfg.locked_folder_id ?? "hidden"}).`
        : "Unlocked channel mode.";
      setConnectionInfo(`Connected. Server ${health.status} v${health.version}. ${lockLabel}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to connect to API server.";
      setConnected(false);
      setConnectionError(message);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = () => {
    setConnected(false);
    setFiles([]);
    setTotal(0);
    setFilesError("");
    setConnectionInfo("Disconnected.");
  };

  useEffect(() => {
    const loadFiles = async () => {
      if (!connected) return;
      if (!normalizedBaseUrl || !apiKeyInput.trim()) return;

      if (!apiConfig?.locked_mode && folderIdInput.trim() && parsedFolderId === null) {
        setFilesError("Folder ID must be an integer.");
        return;
      }

      setLoadingFiles(true);
      setFilesError("");
      try {
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("limit", String(limit));
        if (search.trim()) params.set("search", search.trim());
        if (!apiConfig?.locked_mode && parsedFolderId !== null) {
          params.set("folder_id", String(parsedFolderId));
        }

        const res = await fetch(`${normalizedBaseUrl}/api/v1/files?${params.toString()}`, {
          headers: {
            "X-API-Key": apiKeyInput.trim(),
          },
        });

        if (!res.ok) throw new Error(await parseApiError(res));

        const data: FilesResponse = await res.json();
        setFiles(data.files);
        setTotal(data.total);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to load files.";
        setFilesError(message);
      } finally {
        setLoadingFiles(false);
      }
    };

    loadFiles();
  }, [apiKeyInput, apiConfig?.locked_mode, connected, folderIdInput, limit, normalizedBaseUrl, page, parsedFolderId, search]);

  const downloadFile = async (file: ApiFile) => {
    if (!normalizedBaseUrl || !apiKeyInput.trim()) return;
    setDownloadingId(file.id);
    try {
      const params = new URLSearchParams();
      if (!apiConfig?.locked_mode && parsedFolderId !== null) {
        params.set("folder_id", String(parsedFolderId));
      }

      const res = await fetch(
        `${normalizedBaseUrl}/api/v1/files/${file.id}/download${params.toString() ? `?${params}` : ""}`,
        {
          headers: {
            "X-API-Key": apiKeyInput.trim(),
          },
        }
      );

      if (!res.ok) throw new Error(await parseApiError(res));

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const name = extractFileName(res.headers.get("content-disposition"), file.name);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Download failed.";
      setFilesError(message);
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <main className="min-h-screen bg-blackbox-bg text-blackbox-text p-6 md:p-10">
      <div className="max-w-6xl mx-auto space-y-6">
        <section className="rounded-3xl border border-blackbox-border bg-gradient-to-br from-blackbox-hover to-blackbox-bg p-6 shadow-xl">
          <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <Link2 size={20} />
                BlackBox Web Mode
              </h1>
              <p className="text-sm text-blackbox-subtext mt-1">
                Connect your hosted backend API, then browse and download files.
              </p>
            </div>
            {apiConfig?.locked_mode && (
              <div className="px-3 py-2 rounded-full text-xs font-semibold bg-blackbox-primary/15 border border-blackbox-primary/30 text-blackbox-primary flex items-center gap-2">
                <Lock size={14} />
                Locked Channel: {apiConfig.locked_folder_id ?? "Configured"}
              </div>
            )}
          </div>

          <form onSubmit={connect} className="grid gap-3 md:grid-cols-[1.2fr_1fr_auto]">
            <div className="relative">
              <input
                type="url"
                value={baseUrlInput}
                onChange={(e) => setBaseUrlInput(e.target.value)}
                placeholder="https://your-api.example.com"
                className="w-full px-3 py-2 pl-10 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
              />
              <Link2 size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-blackbox-subtext" />
            </div>

            <PasswordInput
              value={apiKeyInput}
              onChange={setApiKeyInput}
              placeholder="X-API-Key"
              shown={showApiKey}
              onToggle={() => setShowApiKey((v) => !v)}
            />

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={connecting}
                className="px-4 py-2 rounded-lg bg-blackbox-primary text-blackbox-county-green font-semibold disabled:opacity-60"
              >
                {connecting ? "Connecting..." : "Connect"}
              </button>
              <button
                type="button"
                onClick={disconnect}
                className="px-4 py-2 rounded-lg border border-blackbox-border bg-blackbox-bg"
              >
                Disconnect
              </button>
            </div>
          </form>

          {connectionInfo && <p className="mt-3 text-sm text-emerald-400">{connectionInfo}</p>}
          {connectionError && <p className="mt-3 text-sm text-red-400">{connectionError}</p>}
        </section>

        <section className="rounded-3xl border border-blackbox-border bg-blackbox-hover p-6">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <div>
              <h2 className="text-xl font-bold flex items-center gap-2">
                <Shield size={18} />
                Admin Controls
              </h2>
              <p className="text-sm text-blackbox-subtext">
                Telegram login and backend auth changes are restricted. Share only API key with friends.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAdminPanel((v) => !v)}
              className="px-3 py-2 rounded-lg border border-blackbox-border bg-blackbox-bg text-sm"
            >
              {showAdminPanel ? "Hide Admin Panel" : "Show Admin Panel"}
            </button>
          </div>

          {showAdminPanel && (
            <>
              <div className="grid gap-3 md:grid-cols-3">
                <input
                  type="text"
                  value={apiIdInput}
                  onChange={(e) => setApiIdInput(e.target.value)}
                  placeholder="Telegram API ID"
                  className="px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
                />
                <PasswordInput
                  value={apiHashInput}
                  onChange={setApiHashInput}
                  placeholder="Telegram API Hash"
                  shown={showApiHash}
                  onToggle={() => setShowApiHash((v) => !v)}
                />
                <input
                  type="text"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder="Phone (+880...)"
                  className="px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
                />
              </div>

              <div className="grid gap-3 md:grid-cols-3 mt-3">
                <input
                  type="text"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  placeholder="Verification code"
                  className="px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
                />
                <PasswordInput
                  value={passwordInput}
                  onChange={setPasswordInput}
                  placeholder="2FA password"
                  shown={showPassword}
                  onToggle={() => setShowPassword((v) => !v)}
                />
                <PasswordInput
                  value={adminKeyInput}
                  onChange={setAdminKeyInput}
                  placeholder="Admin key (required)"
                  shown={showAdminKey}
                  onToggle={() => setShowAdminKey((v) => !v)}
                />
              </div>

              <div className="flex gap-2 flex-wrap mt-3">
                <button
                  type="button"
                  onClick={requestCode}
                  disabled={authLoading}
                  className="px-3 py-2 rounded-lg bg-blackbox-primary text-blackbox-county-green font-semibold disabled:opacity-60"
                >
                  Request Code
                </button>
                <button
                  type="button"
                  onClick={signInWithCode}
                  disabled={authLoading}
                  className="px-3 py-2 rounded-lg border border-blackbox-border bg-blackbox-bg disabled:opacity-60"
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={submitPassword}
                  disabled={authLoading}
                  className="px-3 py-2 rounded-lg border border-blackbox-border bg-blackbox-bg disabled:opacity-60"
                >
                  Submit Password
                </button>
                <button
                  type="button"
                  onClick={checkAuthStatus}
                  disabled={authLoading}
                  className="px-3 py-2 rounded-lg border border-blackbox-border bg-blackbox-bg disabled:opacity-60"
                >
                  Check Status
                </button>
              </div>

              {authInfo && <p className="mt-3 text-sm text-emerald-400">{authInfo}</p>}
              {authError && <p className="mt-3 text-sm text-red-400">{authError}</p>}
            </>
          )}
        </section>

        <section className="rounded-3xl border border-blackbox-border bg-blackbox-hover p-6 space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="relative">
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search files"
                className="w-full px-3 py-2 pl-9 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
              />
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-blackbox-subtext" />
            </div>

            {apiConfig?.locked_mode ? (
              <div className="px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border text-sm text-blackbox-subtext flex items-center gap-2">
                <Lock size={14} />
                Channel locked by owner
              </div>
            ) : (
              <input
                value={folderIdInput}
                onChange={(e) => {
                  setFolderIdInput(e.target.value);
                  setPage(1);
                }}
                placeholder="Folder ID (optional)"
                className="px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
              />
            )}

            <select
              value={limit}
              onChange={(e) => {
                setLimit(Number(e.target.value));
                setPage(1);
              }}
              className="px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
            >
              <option value={25}>25 / page</option>
              <option value={50}>50 / page</option>
              <option value={100}>100 / page</option>
              <option value={200}>200 / page</option>
            </select>

            <div className="flex items-center text-sm text-blackbox-subtext">
              {connected ? `Total: ${total}` : "Connect first"}
            </div>
          </div>

          {filesError && <p className="text-sm text-red-400">{filesError}</p>}

          <div className="overflow-auto border border-blackbox-border rounded-xl">
            <table className="w-full text-sm">
              <thead className="bg-blackbox-bg">
                <tr>
                  <th className="text-left p-3">Name</th>
                  <th className="text-left p-3">Size</th>
                  <th className="text-left p-3">Created</th>
                  <th className="text-left p-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {loadingFiles ? (
                  <tr>
                    <td className="p-3" colSpan={4}>Loading files...</td>
                  </tr>
                ) : files.length === 0 ? (
                  <tr>
                    <td className="p-3 text-blackbox-subtext" colSpan={4}>No files found.</td>
                  </tr>
                ) : (
                  files.map((file) => (
                    <tr key={file.id} className="border-t border-blackbox-border">
                      <td className="p-3">{file.name}</td>
                      <td className="p-3">{formatBytes(file.size)}</td>
                      <td className="p-3">{file.created_at}</td>
                      <td className="p-3">
                        <button
                          onClick={() => downloadFile(file)}
                          disabled={downloadingId === file.id}
                          className="px-3 py-1 rounded-md bg-blackbox-primary text-blackbox-county-green disabled:opacity-60 inline-flex items-center gap-2"
                        >
                          <Download size={14} />
                          {downloadingId === file.id ? "Downloading..." : "Download"}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={!connected || page <= 1}
              className="px-3 py-2 rounded-lg border border-blackbox-border disabled:opacity-60"
            >
              Previous
            </button>
            <span className="text-sm text-blackbox-subtext">
              Page {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={!connected || page >= totalPages}
              className="px-3 py-2 rounded-lg border border-blackbox-border disabled:opacity-60"
            >
              Next
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
