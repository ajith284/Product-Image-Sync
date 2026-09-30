"use client";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  FolderIcon,
  HardDriveIcon,
  ShoppingBagIcon,
} from "lucide-react";
import { useActionState, useState } from "react";

import { createStore } from "@/app/(app)/stores/actions";
import { SetupStepper, type Step } from "@/components/stores/setup-stepper";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { IMAGE_TYPES } from "@/lib/supabase/constants";
import { storeInfoSchema } from "@/lib/validation/store";

const STEPS: Step[] = [
  { id: "info", title: "Store information" },
  { id: "shopify", title: "Shopify" },
  { id: "drive", title: "Google Drive" },
  { id: "config", title: "Configuration" },
  { id: "review", title: "Review" },
];

type Errors = Partial<Record<"name" | "shopifyDomain", string>>;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function ComingLater({ icon: Icon, title, text }: { icon: typeof ShoppingBagIcon; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </span>
      <p className="font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{text}</p>
      <Badge variant="secondary">Coming soon</Badge>
    </div>
  );
}

export function AddStoreWizard() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [state, formAction, pending] = useActionState(createStore, undefined);

  const normalized = storeInfoSchema.safeParse({ name, shopifyDomain: domain });

  // When the server rejects a field (e.g. duplicate domain), return to step 1 and show it.
  const [handledState, setHandledState] = useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state?.fieldErrors && Object.keys(state.fieldErrors).length) {
      setErrors(state.fieldErrors);
      setStep(0);
    }
  }
  const shownErrors = errors;

  const next = () => {
    if (step === 0) {
      if (!normalized.success) {
        const e: Errors = {};
        for (const issue of normalized.error.issues) {
          const key = issue.path[0] as keyof Errors;
          e[key] ??= issue.message;
        }
        setErrors(e);
        return;
      }
      setErrors({});
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const currentStep = step;

  return (
    <div className="grid gap-6">
      <SetupStepper steps={STEPS} current={currentStep} />

      <Card>
        {currentStep === 0 ? (
          <>
            <CardHeader>
              <CardTitle>Store information</CardTitle>
              <CardDescription>Tell us which Shopify store you want to sync images to.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor="store-name">Store name</Label>
                <Input
                  id="store-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setErrors((prev) => ({ ...prev, name: undefined }));
                  }}
                  placeholder="Royal Sofa"
                  aria-invalid={Boolean(shownErrors.name)}
                  autoFocus
                />
                {shownErrors.name ? (
                  <p className="text-sm text-destructive">{shownErrors.name}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">Only you and your team see this name.</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="store-domain">Shopify domain</Label>
                <Input
                  id="store-domain"
                  value={domain}
                  onChange={(e) => {
                    setDomain(e.target.value);
                    setErrors((prev) => ({ ...prev, shopifyDomain: undefined }));
                  }}
                  placeholder="royal-sofa.myshopify.com"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="url"
                  aria-invalid={Boolean(shownErrors.shopifyDomain)}
                />
                {shownErrors.shopifyDomain ? (
                  <p className="text-sm text-destructive">{shownErrors.shopifyDomain}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Find it in Shopify admin → Settings → Domains. It ends in .myshopify.com.
                  </p>
                )}
              </div>
            </CardContent>
          </>
        ) : null}

        {currentStep === 1 ? (
          <>
            <CardHeader>
              <CardTitle>Shopify connection</CardTitle>
              <CardDescription>Approve access in Shopify — no passwords or API keys to copy.</CardDescription>
            </CardHeader>
            <CardContent>
              <ComingLater
                icon={ShoppingBagIcon}
                title="Connect Shopify"
                text="Shopify connection will be available in the next phase."
              />
            </CardContent>
          </>
        ) : null}

        {currentStep === 2 ? (
          <>
            <CardHeader>
              <CardTitle>Google Drive</CardTitle>
              <CardDescription>Choose the Drive folder that holds your product images.</CardDescription>
            </CardHeader>
            <CardContent>
              <ComingLater
                icon={HardDriveIcon}
                title="Connect Google Drive"
                text="Google Drive connection will be available later."
              />
            </CardContent>
          </>
        ) : null}

        {currentStep === 3 ? (
          <>
            <CardHeader>
              <CardTitle>Configuration preview</CardTitle>
              <CardDescription>These defaults apply when syncing starts. You can adjust them later.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                <Row label="Matching">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5">
                      <FolderIcon className="size-4 text-muted-foreground" /> Drive folder name
                    </span>
                    <ArrowRightIcon className="size-4 text-muted-foreground" />
                    <span className="inline-flex items-center gap-1.5">
                      <ShoppingBagIcon className="size-4 text-muted-foreground" /> Shopify product title
                    </span>
                  </span>
                  <p className="mt-1 text-muted-foreground">
                    e.g. folder “Milano” matches “Milano 3 Seater Sofa”. If more than one product matches, it goes to Review.
                  </p>
                </Row>
                <Row label="Ignored folders">
                  <Badge variant="secondary">OG</Badge>
                </Row>
                <Row label="Images">
                  <span className="flex flex-wrap gap-1.5">
                    {IMAGE_TYPES.map((t) => (
                      <Badge key={t} variant="outline">
                        {t}
                      </Badge>
                    ))}
                  </span>
                </Row>
                <Row label="Existing images">Kept. New images are added; nothing is deleted.</Row>
                <Row label="Product status">Never changed (Draft stays Draft, Active stays Active).</Row>
              </dl>
            </CardContent>
          </>
        ) : null}

        {currentStep === 4 ? (
          <>
            <CardHeader>
              <CardTitle>Review</CardTitle>
              <CardDescription>Check the details, then add the store. You can connect Shopify and Google Drive afterwards.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {state?.error ? (
                <Alert variant="destructive">
                  <AlertDescription>{state.error}</AlertDescription>
                </Alert>
              ) : null}
              <dl className="divide-y">
                <Row label="Store name">{name}</Row>
                <Row label="Shopify domain">{normalized.success ? normalized.data.shopifyDomain : domain}</Row>
                <Row label="Shopify">
                  <Badge variant="outline">Not connected</Badge>
                </Row>
                <Row label="Google Drive">
                  <Badge variant="outline">Not connected</Badge>
                </Row>
                <Row label="Matching">Drive folder name → Shopify product title</Row>
                <Row label="Ignored folders">OG</Row>
                <Row label="Images">{IMAGE_TYPES.join(", ")}</Row>
              </dl>
            </CardContent>
          </>
        ) : null}

        <Separator />
        <CardFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button variant="ghost" onClick={back} disabled={currentStep === 0 || pending} className="w-full sm:w-auto">
            <ArrowLeftIcon />
            Back
          </Button>
          {currentStep < STEPS.length - 1 ? (
            <Button onClick={next} className="w-full sm:w-auto">
              Continue
              <ArrowRightIcon />
            </Button>
          ) : (
            <form action={formAction} className="w-full sm:w-auto">
              <input type="hidden" name="name" value={name} />
              <input type="hidden" name="shopifyDomain" value={domain} />
              <Button type="submit" disabled={pending} className="w-full">
                <CheckCircle2Icon />
                {pending ? "Adding store…" : "Add store"}
              </Button>
            </form>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
