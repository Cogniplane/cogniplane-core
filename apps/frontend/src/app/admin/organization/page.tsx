import { redirect } from "next/navigation";

// The organization name and slug show on Overview.
export default function AdminOrganizationPage() {
  redirect("/admin/overview");
}
