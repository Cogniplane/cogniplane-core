import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

// Privacy activity is now a tab of Privacy. Keep old links and their query.
export default async function AdminPiiPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  query.set("tab", "activity");
  redirect(`/admin/privacy?${query.toString()}`);
}
