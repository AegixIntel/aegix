"use client";

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";

/** Store the current location as the return target and go to the login flow. */
export function useRequireAuth() {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  /** If the user is authenticated, invoke `fn`; otherwise redirect to /app/login
   *  with the intended destination preserved so it can be resumed after login. */
  const requireAuth = useCallback(
    async (fn?: () => void | Promise<void>) => {
      if (user) {
        await fn?.();
        return true;
      }
      const returnTo = `${pathname}${window.location.search}`;
      router.push(`/app/login?returnTo=${encodeURIComponent(returnTo)}`);
      return false;
    },
    [user, pathname, router]
  );

  return { user, requireAuth };
}
