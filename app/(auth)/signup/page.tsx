import Link from "next/link";
import {
  CheckCircle2Icon,
  ImagesIcon,
  SparklesIcon,
} from "lucide-react";

import { signup } from "@/app/(auth)/actions";
import { AuthForm } from "@/components/auth/auth-form";

export const metadata = { title: "Create account" };

const benefits = [
  "Analyse product images and organise catalogue data",
  "Generate SEO-ready product content from visual evidence",
  "Export approved products in Shopify-ready CSV format",
];

export default function SignupPage() {
  return (
    <main className="min-h-svh bg-white text-zinc-950">
      <div className="grid min-h-svh lg:grid-cols-[1.05fr_0.95fr]">
        <section className="relative hidden overflow-hidden bg-zinc-950 px-12 py-10 text-white lg:flex lg:flex-col xl:px-16 xl:py-12">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(255,255,255,0.12),transparent_30%),radial-gradient(circle_at_80%_80%,rgba(255,255,255,0.08),transparent_34%)]" />

          <div className="relative z-10 flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/10 shadow-sm backdrop-blur">
              <ImagesIcon className="size-5" />
            </span>

            <div>
              <div className="text-sm font-semibold tracking-wide">
                Product Image Sync
              </div>
              <div className="text-xs text-white/55">
                Catalogue Studio
              </div>
            </div>
          </div>

          <div className="relative z-10 my-auto max-w-xl py-16">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/70">
              <SparklesIcon className="size-3.5" />
              AI-powered catalogue operations
            </div>

            <h1 className="max-w-lg text-4xl font-semibold leading-[1.08] tracking-[-0.035em] xl:text-5xl">
              Turn product images into Shopify-ready catalogues.
            </h1>

            <p className="mt-5 max-w-lg text-base leading-7 text-white/60">
              Process furniture imagery, review the generated catalogue data,
              and export approved products from one focused workspace.
            </p>

            <div className="mt-10 grid gap-4">
              {benefits.map((benefit) => (
                <div
                  key={benefit}
                  className="flex items-start gap-3 text-sm text-white/75"
                >
                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-white" />
                  <span>{benefit}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="relative z-10 text-xs text-white/40">
            Product Image Sync · Catalogue Studio
          </div>
        </section>

        <section className="flex min-h-svh items-center justify-center bg-zinc-50/70 px-5 py-8 sm:px-8 lg:px-12">
          <div className="w-full max-w-md">
            <div className="mb-8 flex items-center gap-3 lg:hidden">
              <span className="flex size-10 items-center justify-center rounded-xl bg-zinc-950 text-white shadow-sm">
                <ImagesIcon className="size-5" />
              </span>

              <div>
                <div className="text-sm font-semibold">
                  Product Image Sync
                </div>
                <div className="text-xs text-zinc-500">
                  Catalogue Studio
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-zinc-200/80 bg-white p-6 shadow-[0_20px_70px_-35px_rgba(0,0,0,0.28)] sm:p-8">
              <div className="mb-7">
                <div className="mb-3 inline-flex rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600">
                  Create account
                </div>

                <h2 className="text-3xl font-semibold tracking-[-0.03em] text-zinc-950">
                  Start your workspace
                </h2>

                <p className="mt-2 max-w-sm text-sm leading-6 text-zinc-500">
                  Enter your details to create your Catalogue Studio account.
                </p>
              </div>

              <div className="grid gap-6 [&_button]:h-11 [&_button]:rounded-xl [&_button]:font-semibold [&_input]:h-11 [&_input]:rounded-xl [&_input]:border-zinc-200 [&_input]:bg-zinc-50/70 [&_input]:px-3.5 [&_input]:shadow-none [&_input]:transition [&_input]:focus-visible:border-zinc-400 [&_input]:focus-visible:bg-white [&_label]:font-medium [&_label]:text-zinc-700">
                <AuthForm action={signup} mode="signup" />
              </div>

              <div className="mt-7 border-t border-zinc-100 pt-6 text-center text-sm text-zinc-500">
                Already have an account?{" "}
                <Link
                  href="/login"
                  className="font-semibold text-zinc-950 underline-offset-4 hover:underline"
                >
                  Sign in
                </Link>
              </div>
            </div>

            <p className="mx-auto mt-5 max-w-sm text-center text-xs leading-5 text-zinc-400">
              By creating an account, you can continue to workspace setup and
              connect your catalogue workflow.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
