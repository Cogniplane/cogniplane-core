import { redirect } from "next/navigation";

// The organization name and slug now show on Overview.
export default function AdminOrganizationPage() {
  redirect("/admin/overview");
}
