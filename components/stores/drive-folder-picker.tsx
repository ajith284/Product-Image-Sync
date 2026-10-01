"use client";

import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  EyeOffIcon,
  FolderIcon,
  FolderOpenIcon,
  HardDriveIcon,
  ImageIcon,
  Loader2Icon,
  SearchIcon,
  ShoppingBagIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { addGoogleCategoryRoot, selectGoogleRootFolder } from "@/app/(app)/stores/[id]/google-actions";
import { formatDate } from "@/components/stores/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Mirrors the safe JSON returned by POST /api/google/folders. */
type FolderItem = {
  id: string;
  name: string;
  parentId: string | null;
  modifiedTime: string | null;
  ignored: boolean;
  sharedDrive?: boolean;
};
type ImageItem = { id: string; name: string; mimeType: string; modifiedTime: string | null; size: number | null };
type Listing = {
  folder: { id: string; name: string; kind: "my-drive" | "shared-drives" | "folder"; ignored: boolean };
  folders: FolderItem[];
  nextPageToken: string | null;
  images: ImageItem[];
  imagesTruncated: boolean;
  search: string | null;
};
type Crumb = { id: string; name: string };
type MatchPreview =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "done"; products: { id: string; title: string; status: string }[] };

const MY_DRIVE: Crumb = { id: "root", name: "My Drive" };
const SHARED: Crumb = { id: "shared-drives", name: "Shared drives" };
const IMAGE_PREVIEW_LIMIT = 8;

function formatSize(bytes: number | null) {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DriveFolderPicker({
  storeId,
  open,
  onOpenChange,
  currentRootName,
  mode = "root",
  connectedRootIds = [],
}: {
  storeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentRootName: string | null;
  /** "category" (Prompt 12) adds a category folder; "root" keeps the Prompt 7 single-root behaviour. */
  mode?: "root" | "category";
  connectedRootIds?: string[];
}) {
  const router = useRouter();
  const [path, setPath] = useState<Crumb[]>([MY_DRIVE]);
  const [listing, setListing] = useState<Listing | null>(null);
  // Mounted only while open: starts by loading My Drive.
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [showAllImages, setShowAllImages] = useState(false);
  const [matches, setMatches] = useState<MatchPreview>({ state: "idle" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const requestSeq = useRef(0);

  /** One request to the folders API (no state changes). */
  const fetchListing = useCallback(
    async (
      parentFolderId: string,
      opts: { search?: string; pageToken?: string },
    ): Promise<{ ok: true; body: Listing } | { ok: false; error: string }> => {
      try {
        const res = await fetch("/api/google/folders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storeId, parentFolderId, search: opts.search || undefined, pageToken: opts.pageToken }),
        });
        const body = (await res.json().catch(() => null)) as (Listing & { error?: string }) | null;
        if (!res.ok || !body || body.error) {
          return { ok: false, error: body?.error ?? "We couldn't load your Google Drive folders. Please try again." };
        }
        return { ok: true, body };
      } catch {
        return { ok: false, error: "We couldn't reach the server. Please try again." };
      }
    },
    [storeId],
  );

  /** Apply a finished request (ignored if a newer request was started meanwhile). */
  const apply = useCallback(
    (seq: number, result: Awaited<ReturnType<typeof fetchListing>>, append: boolean) => {
      if (seq !== requestSeq.current) return;
      if (result.ok) {
        setListing((prev) =>
          append && prev ? { ...result.body, folders: [...prev.folders, ...result.body.folders], images: prev.images } : result.body,
        );
      } else {
        setError(result.error);
      }
      setLoading(false);
      setLoadingMore(false);
    },
    [],
  );

  const load = useCallback(
    async (parentFolderId: string, opts: { search?: string; pageToken?: string } = {}) => {
      const seq = ++requestSeq.current;
      if (opts.pageToken) setLoadingMore(true);
      else {
        setLoading(true);
        setListing(null);
        setShowAllImages(false);
        setMatches({ state: "idle" });
      }
      setError(null);
      apply(seq, await fetchListing(parentFolderId, opts), Boolean(opts.pageToken));
    },
    [apply, fetchListing],
  );

  // Initial load of My Drive.
  useEffect(() => {
    const seq = ++requestSeq.current;
    void fetchListing(MY_DRIVE.id, {}).then((r) => apply(seq, r, false));
  }, [apply, fetchListing]);

  const current = path[path.length - 1]!;
  const goTo = (next: Crumb[]) => {
    setPath(next);
    setSearchInput("");
    setSaveError(null);
    void load(next[next.length - 1]!.id);
  };
  const openFolder = (f: FolderItem) => goTo([...path, { id: f.id, name: f.name }]);
  const goBack = () => path.length > 1 && goTo(path.slice(0, -1));
  const runSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void load(current.id, { search: searchInput.trim() });
  };
  const clearSearch = () => {
    setSearchInput("");
    void load(current.id);
  };

  const isRealFolder = listing?.folder.kind === "folder" && listing.folder.id === current.id;
  const alreadyConnected = Boolean(mode === "category" && listing && connectedRootIds.includes(listing.folder.id));
  const canSelect = Boolean(isRealFolder && !listing?.folder.ignored && !loading && !alreadyConnected);

  const select = () => {
    if (!canSelect || !listing) return;
    setSaveError(null);
    startSaving(async () => {
      const r =
        mode === "category"
          ? await addGoogleCategoryRoot(storeId, listing.folder.id)
          : await selectGoogleRootFolder(storeId, listing.folder.id);
      if (r?.error) {
        setSaveError(r.error);
        return;
      }
      toast.success(r?.message ?? (mode === "category" ? "Category folder connected." : "Root folder saved."));
      onOpenChange(false);
      router.refresh();
    });
  };

  const previewMatches = async () => {
    if (!listing) return;
    setMatches({ state: "loading" });
    try {
      const res = await fetch("/api/shopify/products/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId, searchTerm: listing.folder.name }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; products?: { id: string; title: string; status: string }[] }
        | null;
      if (!res.ok || !body || body.error) setMatches({ state: "error", message: body?.error ?? "Shopify search failed." });
      else setMatches({ state: "done", products: body.products ?? [] });
    } catch {
      setMatches({ state: "error", message: "We couldn't reach the server." });
    }
  };

  const images = listing?.images ?? [];
  const shownImages = showAllImages ? images : images.slice(0, IMAGE_PREVIEW_LIMIT);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle>Select Google Drive folder</SheetTitle>
          <SheetDescription>
            Choose the folder that contains your product folders (e.g. <span className="font-medium">Sofa</span>).
            Read-only — nothing in Drive is changed.
          </SheetDescription>
          <div className="mt-2 flex gap-1" role="tablist" aria-label="Drive location">
            {[MY_DRIVE, SHARED].map((loc) => (
              <Button
                key={loc.id}
                type="button"
                role="tab"
                aria-selected={path[0]!.id === loc.id}
                size="sm"
                variant={path[0]!.id === loc.id ? "secondary" : "ghost"}
                onClick={() => goTo([loc])}
              >
                {loc.id === MY_DRIVE.id ? <HardDriveIcon /> : <UsersIcon />}
                {loc.name}
              </Button>
            ))}
          </div>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {/* Breadcrumbs */}
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              onClick={goBack}
              disabled={path.length < 2}
              aria-label="Go to parent folder"
            >
              <ArrowLeftIcon />
            </Button>
            <nav aria-label="Current location" className="min-w-0 flex-1">
              <ol className="flex flex-wrap items-center gap-0.5 text-sm">
                {path.map((c, i) => (
                  <li key={`${c.id}-${i}`} className="flex min-w-0 items-center gap-0.5">
                    {i > 0 ? <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                    {i === path.length - 1 ? (
                      <span className="truncate px-1 font-medium" aria-current="page">
                        {c.name}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => goTo(path.slice(0, i + 1))}
                        className="truncate rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        {c.name}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          </div>

          {/* Search inside the current location (submitted, not per keystroke) */}
          <form onSubmit={runSearch} className="flex gap-2" role="search">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={`Search folders in ${current.name}`}
                className="pl-8"
                maxLength={100}
                aria-label="Search folders"
              />
            </div>
            <Button type="submit" variant="secondary" disabled={loading || !searchInput.trim()}>
              Search
            </Button>
            {listing?.search ? (
              <Button type="button" variant="ghost" size="icon" onClick={clearSearch} aria-label="Clear search">
                <XIcon />
              </Button>
            ) : null}
          </form>

          {error ? (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {error}
                <Button size="sm" variant="outline" onClick={() => void load(current.id)}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {/* Folder summary */}
          {isRealFolder && listing ? (
            <div className="grid gap-1 rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <FolderOpenIcon className="size-4 text-muted-foreground" />
                <span className="font-medium break-all">{listing.folder.name}</span>
                {listing.folder.ignored ? (
                  <Badge variant="outline" className="gap-1">
                    <EyeOffIcon className="size-3" /> Ignored
                  </Badge>
                ) : null}
              </div>
              <span className="font-mono text-xs break-all text-muted-foreground">ID: {listing.folder.id}</span>
              <span className="text-xs text-muted-foreground">
                {listing.folders.length}
                {listing.nextPageToken ? "+" : ""} {listing.folders.length === 1 ? "folder" : "folders"} ·{" "}
                {images.length}
                {listing.imagesTruncated ? "+" : ""} supported {images.length === 1 ? "image" : "images"}
              </span>
              {listing.folder.ignored ? (
                <span className="text-xs text-muted-foreground">
                  The sync will skip this folder and everything in it.
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Folder list */}
          {loading ? (
            <div className="grid gap-2" aria-busy="true" aria-label="Loading folders...">
              <span className="sr-only">Loading folders...</span>
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : listing ? (
            listing.folders.length === 0 ? (
              <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                <FolderIcon className="size-5" />
                {listing.search
                  ? `No folders matching “${listing.search}”.`
                  : images.length > 0
                    ? "No subfolders found."
                    : "No folders found."}
              </div>
            ) : (
              <ul className="divide-y rounded-lg border">
                {listing.folders.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => openFolder(f)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    >
                      {f.sharedDrive ? (
                        <UsersIcon className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <FolderIcon className={cn("size-4 shrink-0", f.ignored ? "text-muted-foreground" : "text-sky-600")} />
                      )}
                      <span className={cn("min-w-0 flex-1 truncate text-sm", f.ignored && "text-muted-foreground")}>
                        {f.name}
                      </span>
                      {f.ignored ? (
                        <Badge variant="outline" className="gap-1 text-xs">
                          <EyeOffIcon className="size-3" /> Ignored
                        </Badge>
                      ) : f.modifiedTime ? (
                        <span className="hidden text-xs text-muted-foreground sm:inline">{formatDate(f.modifiedTime)}</span>
                      ) : null}
                      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {listing?.nextPageToken && !loading ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loadingMore}
              onClick={() => void load(current.id, { search: listing.search ?? undefined, pageToken: listing.nextPageToken! })}
            >
              {loadingMore ? <Loader2Icon className="animate-spin" /> : null}
              Load more folders
            </Button>
          ) : null}

          {/* Image metadata (no downloads) */}
          {!loading && images.length > 0 ? (
            <section className="grid gap-2" aria-label="Images in this folder">
              <h3 className="flex items-center gap-1.5 text-sm font-medium">
                <ImageIcon className="size-4" /> Images in this folder
                <span className="font-normal text-muted-foreground">(jpg, jpeg, png, webp — preview only)</span>
              </h3>
              <ul className="divide-y rounded-lg border text-sm">
                {shownImages.map((img) => (
                  <li key={img.id} className="grid gap-0.5 px-3 py-2">
                    <span className="font-medium break-all">{img.name}</span>
                    <span className="text-xs break-all text-muted-foreground">
                      {[img.mimeType, img.modifiedTime ? formatDate(img.modifiedTime) : null, formatSize(img.size)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span className="font-mono text-[11px] break-all text-muted-foreground">ID: {img.id}</span>
                  </li>
                ))}
              </ul>
              {images.length > IMAGE_PREVIEW_LIMIT ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowAllImages((v) => !v)}>
                  {showAllImages ? "Show fewer" : `Show all ${images.length}${listing?.imagesTruncated ? "+" : ""} images`}
                </Button>
              ) : null}

              {/* Optional, non-sync matching preview */}
              {!listing?.folder.ignored ? (
                <div className="grid gap-2 rounded-lg border border-dashed p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      Product folder <span className="font-medium">“{listing?.folder.name}”</span>
                    </span>
                    <Button type="button" size="sm" variant="outline" onClick={previewMatches} disabled={matches.state === "loading"}>
                      {matches.state === "loading" ? <Loader2Icon className="animate-spin" /> : <ShoppingBagIcon />}
                      Preview Shopify matches
                    </Button>
                  </div>
                  {matches.state === "error" ? <p className="text-xs text-destructive">{matches.message}</p> : null}
                  {matches.state === "done" ? (
                    matches.products.length ? (
                      <ul className="grid gap-1 text-xs">
                        {matches.products.map((p) => (
                          <li key={p.id} className="flex items-center justify-between gap-2">
                            <span className="break-words">{p.title}</span>
                            <Badge variant="outline">{p.status}</Badge>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted-foreground">No Shopify products contain this name.</p>
                    )
                  ) : null}
                  <p className="text-xs text-muted-foreground">Matching will be handled in a later sync phase.</p>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        <SheetFooter className="border-t bg-background">
          {saveError ? (
            <Alert variant="destructive">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="text-sm">
            <span className="text-muted-foreground">Selected folder: </span>
            <span className="font-medium break-all">
              {isRealFolder && listing ? listing.folder.name : "Open a folder to select it"}
            </span>
            {currentRootName ? (
              <span className="block text-xs text-muted-foreground">Current root: {currentRootName}</span>
            ) : null}
            {listing?.folder.ignored ? (
              <span className="block text-xs text-muted-foreground">Ignored folders can&apos;t be the root.</span>
            ) : null}
            {alreadyConnected ? (
              <span className="block text-xs text-muted-foreground">This category folder is already connected.</span>
            ) : null}
            {mode === "category" ? (
              <span className="block text-xs text-muted-foreground">
                Choose a category folder (e.g. &quot;Sofa image&quot;), not a code folder like SOF-001.
              </span>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={select} disabled={!canSelect || saving}>
              {saving ? <Loader2Icon className="animate-spin" /> : <FolderIcon />}
              {mode === "category" ? "Connect this category folder" : "Select this folder"}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
