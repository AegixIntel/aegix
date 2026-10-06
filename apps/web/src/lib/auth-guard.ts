"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";

/** Store the current location as the return target and go to the login flow. */
export function useRequireAuth() {
  const { user, ready } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const session = useRef({ user, ready, mounted: true });

  useEffect(() => {
    session.current = { user, ready, mounted: true };
    return () => { session.current.mounted = false; };
  }, [user, ready]);

  /** If the user is authenticated, invoke `fn`; otherwise redirect to /app/login
   *  with the intended destination preserved so it can be resumed after login. */
  const requireAuth = useCallback(
    async (fn?: () => void | Promise<void>) => {
      // A press while the session is still being restored waits for the
      // answer. Without this a signed-in visitor is sent to the login page,
      // which sends them straight back to an emptied form.
      while (!session.current.ready && session.current.mounted) await new Promise((resolve) => setTimeout(resolve, 50));
      if (!session.current.mounted) return false;
      if (session.current.user) {
        await fn?.();
        return true;
      }
      const returnTo = `${pathname}${window.location.search}`;
      router.push(`/app/login?returnTo=${encodeURIComponent(returnTo)}`);
      return false;
    },
    [pathname, router]
  );

  return { user, requireAuth };
}
