import { AuthGuard } from "../lib/auth-guard";
import { ChatShell } from "../components/chat-shell";

export default function HomePage() {
  return (
    <AuthGuard>
      <ChatShell />
    </AuthGuard>
  );
}
