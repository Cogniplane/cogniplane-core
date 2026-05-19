"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return message.includes("401") || message.toLowerCase().includes("unauthorized");
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < 2 && !isAuthError(error);
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: shouldRetryQuery
          },
          mutations: {
            retry: false
          }
        }
      })
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
