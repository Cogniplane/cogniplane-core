import { Suspense } from "react";
import { AdminHistoryPage } from "../../../components/admin/history/admin-history-page";

export default function Page() {
  return <Suspense fallback={<p role="status" className="pt-6">Loading change history...</p>}><AdminHistoryPage /></Suspense>;
}
