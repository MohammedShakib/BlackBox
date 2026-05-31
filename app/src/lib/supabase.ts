import { createClient } from "@supabase/supabase-js";

const rawUrl = import.meta.env.VITE_SUPABASE_URL;
const rawAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
export const supabaseAnonKey = typeof rawAnonKey === "string" ? rawAnonKey.trim() : "";

export const hasSupabaseEnv = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = hasSupabaseEnv
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

const WEB_MODE_SETTINGS_TABLE = "web_mode_settings";
const WEB_MODE_SETTINGS_ID = "global";
const CHANNEL_CACHE_TABLE = "channel_file_cache";

export type WebModeSettingsPayload = {
  mode: "web_mode";
  baseUrl: string;
  apiKey: string;
  apiId: string;
  apiHash: string;
  phone: string;
  adminKey: string;
  rememberAdminInputs: boolean;
  showAdminPanel: boolean;
};

type WebModeSettingsRow = {
  id: string;
  payload: unknown;
};

type SupabaseActionResult<T> = {
  data: T | null;
  error: string | null;
};

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toBoolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function coerceWebModePayload(payload: unknown): WebModeSettingsPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const raw = payload as Record<string, unknown>;

  return {
    mode: "web_mode",
    baseUrl: toStringValue(raw.baseUrl),
    apiKey: toStringValue(raw.apiKey),
    apiId: toStringValue(raw.apiId),
    apiHash: toStringValue(raw.apiHash),
    phone: toStringValue(raw.phone),
    adminKey: toStringValue(raw.adminKey),
    rememberAdminInputs: toBoolValue(raw.rememberAdminInputs, true),
    showAdminPanel: toBoolValue(raw.showAdminPanel, false),
  };
}

export type CachedFileEntry = {
  id: number;
  folder_id: number | null;
  name: string;
  size: number;
  mime_type?: string | null;
  created_at: string;
};

export type ChannelCacheData = {
  files: CachedFileEntry[];
  total: number;
  synced_at: string;
};

export async function loadChannelCache(
  channelId: string,
): Promise<SupabaseActionResult<ChannelCacheData>> {
  if (!supabase) return { data: null, error: "Supabase env missing." };

  const { data, error } = await supabase
    .from(CHANNEL_CACHE_TABLE)
    .select("files, total, synced_at")
    .eq("channel_id", channelId)
    .maybeSingle();

  if (error) return { data: null, error: error.message };
  if (!data) return { data: null, error: null };

  return {
    data: {
      files: (data.files as CachedFileEntry[]) || [],
      total: data.total as number,
      synced_at: data.synced_at as string,
    },
    error: null,
  };
}

export async function saveChannelCache(
  channelId: string,
  files: CachedFileEntry[],
  total: number,
): Promise<SupabaseActionResult<"saved">> {
  if (!supabase) return { data: null, error: "Supabase env missing." };

  const { error } = await supabase.from(CHANNEL_CACHE_TABLE).upsert(
    { channel_id: channelId, files, total },
    { onConflict: "channel_id" },
  );

  if (error) return { data: null, error: error.message };
  return { data: "saved", error: null };
}

export async function checkSupabaseHealth(): Promise<{ ok: boolean; message: string }> {
  if (!hasSupabaseEnv) {
    return { ok: false, message: "Missing Supabase env variables." };
  }

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/health`, {
      headers: {
        apikey: supabaseAnonKey,
      },
    });

    if (!response.ok) {
      return { ok: false, message: `Supabase check failed (${response.status}).` };
    }

    return { ok: true, message: "Supabase connected." };
  } catch {
    return { ok: false, message: "Failed to reach Supabase endpoint." };
  }
}

export async function loadWebModeSettingsFromSupabase(): Promise<SupabaseActionResult<WebModeSettingsPayload>> {
  if (!supabase) {
    return { data: null, error: "Supabase env missing." };
  }

  const { data, error } = await supabase
    .from(WEB_MODE_SETTINGS_TABLE)
    .select("id, payload")
    .eq("id", WEB_MODE_SETTINGS_ID)
    .maybeSingle<WebModeSettingsRow>();

  if (error) {
    return { data: null, error: error.message };
  }

  if (!data) {
    return { data: null, error: null };
  }

  const payload = coerceWebModePayload(data.payload);
  if (!payload) {
    return { data: null, error: "Invalid Supabase settings payload." };
  }

  return { data: payload, error: null };
}

export async function saveWebModeSettingsToSupabase(
  payload: WebModeSettingsPayload,
): Promise<SupabaseActionResult<"saved">> {
  if (!supabase) {
    return { data: null, error: "Supabase env missing." };
  }

  const { error } = await supabase.from(WEB_MODE_SETTINGS_TABLE).upsert(
    {
      id: WEB_MODE_SETTINGS_ID,
      payload,
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: "id",
    },
  );

  if (error) {
    return { data: null, error: error.message };
  }

  return { data: "saved", error: null };
}
