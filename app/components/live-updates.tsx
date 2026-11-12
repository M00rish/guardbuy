import { useEffect, useRef, useState } from "react";
import {
  useFetchers,
  useLocation,
  useNavigate,
  useNavigation,
  useRevalidator,
} from "react-router";
import { livePage, startLivePolling } from "../lib/live/poll";

function editing() {
  const active = document.activeElement;
  return (
    !!active?.closest(
      "input, textarea, select, [contenteditable=true], s-text-field, s-number-field, s-search-field, s-select, s-text-area",
    ) ||
    !!document.querySelector(
      "[data-live-editing=true], s-modal[open], dialog[open], [role=dialog][aria-modal=true]",
    )
  );
}

/** Revalidate in place so grids retain their filters, selection, expansion and scroll. */
export function useLiveUpdates() {
  const location = useLocation(),
    navigate = useNavigate(),
    navigation = useNavigation();
  const revalidator = useRevalidator(),
    fetchers = useFetchers();
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef({
    location,
    navigate,
    navigation,
    revalidator,
    fetchers,
  });
  latest.current = { location, navigate, navigation, revalidator, fetchers };
  const enabled = livePage(location.pathname, location.search);

  useEffect(() => {
    setRefreshing(false);
    if (!enabled) return;
    let mounted = true;
    let stop = () => {};
    const start = () => {
      stop();
      if (document.visibilityState === "hidden" || !navigator.onLine) return;
      stop = startLivePolling({
        ready: () => {
          const { navigation, revalidator, fetchers } = latest.current;
          return (
            document.visibilityState !== "hidden" &&
            navigator.onLine &&
            !editing() &&
            navigation.state === "idle" &&
            revalidator.state === "idle" &&
            fetchers.every((f) => f.state === "idle")
          );
        },
        revision: async (signal) => {
          // App Bridge adds the current Shopify session token to same-origin fetches.
          const response = await fetch("/app/live-state", {
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            headers: { Accept: "application/json" },
            cache: "no-store",
          });
          if (
            !response.ok ||
            !response.headers.get("content-type")?.includes("application/json")
          )
            throw new Error("Live update unavailable");
          const data = await response.json();
          if (typeof data.revision !== "string")
            throw new Error("Invalid live update");
          return data.revision;
        },
        refresh: async () => {
          if (mounted) setRefreshing(true);
          try {
            const { location, navigate, revalidator } = latest.current;
            // Background status refreshes must never run the PayPal Order capture sweep.
            if (
              location.pathname === "/app/rules" &&
              new URLSearchParams(location.search).get("payoutRefresh") !== "1"
            ) {
              const params = new URLSearchParams(location.search);
              params.set("payoutRefresh", "1");
              await navigate(`${location.pathname}?${params}`, {
                replace: true,
                preventScrollReset: true,
              });
            } else await revalidator.revalidate();
          } finally {
            if (mounted) setRefreshing(false);
          }
        },
        now: Date.now,
        schedule: (fn, delay) => {
          const timer = setTimeout(fn, delay);
          return () => clearTimeout(timer);
        },
      });
    };
    start();
    document.addEventListener("visibilitychange", start);
    window.addEventListener("online", start);
    window.addEventListener("offline", start);
    return () => {
      mounted = false;
      stop();
      document.removeEventListener("visibilitychange", start);
      window.removeEventListener("online", start);
      window.removeEventListener("offline", start);
    };
  }, [enabled, location.pathname, location.search]);
  return refreshing;
}
