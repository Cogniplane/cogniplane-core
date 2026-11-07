import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

// Privacy activity is a tab of Privacy. Old links and their query strings must keep working.
export default async function AdminPiiPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  query.set("tab", "activity");
  redirect(`/admin/privacy?${query.toString()}`);
}
