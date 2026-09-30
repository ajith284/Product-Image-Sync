import { describe, expect, it } from "vitest";

import {
  classifyMatches,
  filterMatchingProducts,
  matchFolderToProducts,
  normalizeMatchText,
  titleMatches,
} from "@/lib/matching/product-match";

const products = [
  { title: "Milano 3 Seater Sofa" },
  { title: "Milano Corner Sofa" },
  { title: "Milano Recliner" },
  { title: "Roma Sofa" },
  { title: "Romance Chair" },
  { title: "SOF-001 Vienna Bed" },
];

describe("normalizeMatchText", () => {
  it.each([
    [" Milano ", "milano"],
    ["MILANO", "milano"],
    ["Milano   3  Seater", "milano 3 seater"],
    ["\tMilano Sofa\n", "milano sofa"],
    ["Café", "café"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeMatchText(input)).toBe(expected);
  });

  it("keeps meaningful characters (digits, punctuation)", () => {
    expect(normalizeMatchText("Milano 3-Seater (Grey) & Co.")).toBe("milano 3-seater (grey) & co.");
  });

  it("treats composed and decomposed accents as equal (Drive on macOS)", () => {
    expect(normalizeMatchText("Café")).toBe(normalizeMatchText("Café"));
  });

  it("does not modify the original title", () => {
    const p = { title: "  Milano 3 Seater Sofa " };
    filterMatchingProducts("milano", [p]);
    expect(p.title).toBe("  Milano 3 Seater Sofa ");
  });
});

describe("titleMatches (contains rule)", () => {
  it("folder name contained in title", () => {
    expect(titleMatches("Milano 3 Seater Sofa", "Milano")).toBe(true);
    expect(titleMatches("Milano 3 Seater Sofa", "  milano  3 seater ")).toBe(true);
  });
  it("is not a word-order/fuzzy match", () => {
    expect(titleMatches("Milano 3 Seater Sofa", "Milano Sofa")).toBe(false);
    expect(titleMatches("Milano 3 Seater Sofa", "Milan0")).toBe(false);
  });
  it("empty / whitespace-only names never match", () => {
    expect(titleMatches("Milano", "")).toBe(false);
    expect(titleMatches("Milano", "   ")).toBe(false);
  });
});

describe("matchFolderToProducts", () => {
  it("one match", () => {
    const r = matchFolderToProducts("Vienna", products);
    expect(r.status).toBe("single_match");
    expect(r.matches.map((p) => p.title)).toEqual(["SOF-001 Vienna Bed"]);
  });

  it("multiple matches: returns ALL, selects none", () => {
    const r = matchFolderToProducts("Milano", products);
    expect(r.status).toBe("multiple_matches");
    expect(r.matches.map((p) => p.title)).toEqual([
      "Milano 3 Seater Sofa",
      "Milano Corner Sofa",
      "Milano Recliner",
    ]);
    expect(r).not.toHaveProperty("selected");
  });

  it("no match → []", () => {
    const r = matchFolderToProducts("Oslo", products);
    expect(r).toEqual({ status: "no_product_found", matches: [] });
  });

  it("substring rule: Roma also matches Romance (goes to review)", () => {
    expect(matchFolderToProducts("Roma", products).status).toBe("multiple_matches");
  });

  it("classifyMatches copies the list", () => {
    const list = [{ title: "a" }];
    const r = classifyMatches(list);
    expect(r.matches).not.toBe(list);
  });
});
