"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../lib/auth-context";
import { fetchAuthConfig } from "../../lib/local-auth-api";
import { queryKeys } from "../../lib/query-keys";
import { LoginView } from "../../components/auth/login-view";

export default function LoginPage() {
  const router = useRouter();
  const { completeLogin, login } = useAuth();
  const configQuery = useQuery({ queryKey: queryKeys.auth.config(), queryFn: fetchAuthConfig, retry: 1 });
  const onSignedIn = async (accessToken: string) => {
    const ok = await completeLogin(accessToken);
    if (ok) router.replace("/");
    return ok;
  };
  return <LoginView config={configQuery.data ?? null} configError={configQuery.isError} onConfigRetry={() => configQuery.refetch()} onSignedIn={onSignedIn} login={login} />;
}
