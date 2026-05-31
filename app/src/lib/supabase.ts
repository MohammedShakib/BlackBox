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