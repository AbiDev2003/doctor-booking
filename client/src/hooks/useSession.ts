import { useQuery } from "@tanstack/react-query";
import { apiMe } from "../lib/api";
import type { SessionUser } from "../lib/api";

/**
 * The session as React Query state, so any component (public nav, the doctor
 * shell's role guard) can react to "who am I" without duplicating the boot
 * dance every page used to do by hand.
 *
 * The queryFn swallows the 401 and returns null on purpose: "not signed in" is
 * a normal state for a public page, not a query error to retry, and the server
 * is the only authority on the session — `apiMe` already carries the
 * refresh-retry, so an expired access token is silently resumed before any
 * consumer sees a result.
 */
export function useSession(): {
  user: SessionUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
} {
  const query = useQuery({
    queryKey: ["me"],
    queryFn: () =>
      apiMe()
        .then((result) => result.user)
        .catch(() => null),
    staleTime: 60_000,
    // The query re-runs on mount; a `void queryClient.invalidateQueries({queryKey:["me"]})`
    // after login/logout (see App flows) is what keeps a new sign-in visible to
    // already-mounted shells without a full page bounce.
    refetchOnWindowFocus: false,
  });

  return { user: query.data ?? null, isLoading: query.isLoading, isAuthenticated: query.data !== undefined && query.data !== null };
}