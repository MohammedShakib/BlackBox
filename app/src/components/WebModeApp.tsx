import { FormEvent, useEffect, useMemo, useState } from "react";
import { formatBytes } from "../utils";

type HealthResponse = {
  status: string;
  version: string;
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

const BASE_URL_KEY = "blackbox_web_api_base_url";
const API_KEY_KEY = "blackbox_web_api_key";

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
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }
  const plainMatch = contentDisposition.match(/filename="([^"]+)"/i);
  return plainMatch?.[1] ?? fallback;
}

export function WebModeApp() {
  const [baseUrlInput, setBaseUrlInput] = useState("http://localhost:8787");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionInfo, setConnectionInfo] = useState<string>("");
  const [connectionError, setConnectionError] = useState<string>("");

  const [search, setSearch] = useState("");
  const [folderIdInput, setFolderIdInput] = useState("");
  const [limit, setLimit] = useState(50);
  const [page, setPage] = useState(1);

  const [files, setFiles] = useState<ApiFile[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

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
      if (!healthRes.ok) {
        throw new Error(`Health check failed (${healthRes.status}).`);
      }
      const health: HealthResponse = await healthRes.json();

      const testFilesRes = await fetch(`${normalizedBaseUrl}/api/v1/files?page=1&limit=1`, {
        headers: {
          "X-API-Key": apiKeyInput.trim(),
        },
      });
      if (!testFilesRes.ok) {
        throw new Error(`API auth failed (${testFilesRes.status}). Check API key.`);
      }

      if (typeof window !== "undefined") {
        localStorage.setItem(BASE_URL_KEY, normalizedBaseUrl);
        localStorage.setItem(API_KEY_KEY, apiKeyInput.trim());
      }
      setConnected(true);
      setConnectionInfo(`Connected. Server status: ${health.status}, version: ${health.version}`);
      setPage(1);
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
      if (folderIdInput.trim() && parsedFolderId === null) {
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
        if (parsedFolderId !== null) params.set("folder_id", String(parsedFolderId));

        const res = await fetch(`${normalizedBaseUrl}/api/v1/files?${params.toString()}`, {
          headers: {
            "X-API-Key": apiKeyInput.trim(),
          },
        });

        if (!res.ok) {
          throw new Error(`Failed to fetch files (${res.status}).`);
        }

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
  }, [apiKeyInput, connected, folderIdInput, limit, normalizedBaseUrl, page, parsedFolderId, search]);

  const downloadFile = async (file: ApiFile) => {
    if (!normalizedBaseUrl || !apiKeyInput.trim()) return;
    setDownloadingId(file.id);
    try {
      const params = new URLSearchParams();
      if (parsedFolderId !== null) params.set("folder_id", String(parsedFolderId));

      const res = await fetch(
        `${normalizedBaseUrl}/api/v1/files/${file.id}/download${params.toString() ? `?${params}` : ""}`,
        {
          headers: {
            "X-API-Key": apiKeyInput.trim(),
          },
        }
      );

      if (!res.ok) {
        throw new Error(`Download failed (${res.status}).`);
      }

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
        <section className="rounded-2xl border border-blackbox-border bg-blackbox-hover p-6">
          <h1 className="text-2xl font-bold mb-2">BlackBox Web Mode</h1>
          <p className="text-sm text-blackbox-subtext mb-4">
            This mode works with BlackBox REST API. Configure a reachable API server URL and API key to browse and download files from the browser.
          </p>
          <form onSubmit={connect} className="grid gap-3 md:grid-cols-3">
            <input
              type="url"
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
              placeholder="https://your-api.example.com"
              className="px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
            />
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="X-API-Key"
              className="px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
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

        <section className="rounded-2xl border border-blackbox-border bg-blackbox-hover p-6 space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search files"
              className="px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
            />
            <input
              value={folderIdInput}
              onChange={(e) => {
                setFolderIdInput(e.target.value);
                setPage(1);
              }}
              placeholder="Folder ID (optional)"
              className="px-3 py-2 rounded-lg bg-blackbox-bg border border-blackbox-border focus:outline-none focus:ring-2 focus:ring-blackbox-primary"
            />
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
                          className="px-3 py-1 rounded-md bg-blackbox-primary text-blackbox-county-green disabled:opacity-60"
                        >
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
