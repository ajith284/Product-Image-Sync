import { z } from "zod";

import { normalizeShopDomain } from "@/lib/shopify/domain";

export const storeInfoSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a store name.")
    .max(120, "Use at most 120 characters."),
  shopifyDomain: z
    .string()
    .trim()
    .min(1, "Enter your Shopify store address.")
    .transform((v, ctx) => {
      const domain = normalizeShopDomain(v);
      if (!domain) {
        ctx.addIssue({
          code: "custom",
          message: "Enter your store's myshopify.com address, e.g. royal-sofa.myshopify.com",
        });
        return z.NEVER;
      }
      return domain;
    }),
});

export type StoreInfoInput = z.input<typeof storeInfoSchema>;
export type StoreInfo = z.output<typeof storeInfoSchema>;
