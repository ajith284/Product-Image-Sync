export type StoreListItem = {
  id: string;
  name: string;
  shopify_domain: string | null;
  status: string;
  created_at: string;
};

export function formatDate(iso: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(iso));
}
