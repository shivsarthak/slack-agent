"use client";

import { useCallback, useEffect, useState } from "react";

export function useApi<T>(url: string, intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.status === 401) {
        window.location.href = "/login";
        return;
      }
      const j = await r.json();
      if (!r.ok) setError(j.error ?? r.statusText);
      else {
        setData(j as T);
        setError(null);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [url]);
  useEffect(() => {
    void refresh();
    if (intervalMs) {
      const t = setInterval(() => void refresh(), intervalMs);
      return () => clearInterval(t);
    }
  }, [refresh, intervalMs]);
  return { data, error, refresh };
}

export async function apiSend<T = { ok: boolean }>(
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = j.issues
      ? `${j.error}\n${j.issues.map((i: { path?: (string | number)[]; message: string }) => `${(i.path ?? []).join(".")}: ${i.message}`).join("\n")}`
      : (j.error ?? r.statusText);
    throw new Error(detail);
  }
  return j as T;
}
