import type { Qualification } from "./qualify.js";

const PF_API_BASE = process.env.PF_API_BASE ?? "http://localhost:8642";

export interface ListingSummary {
  title: string;
  price: number | null;
  bedrooms: number | null;
  size_value: number | null;
  size_unit: string | null;
  location: string;
  share_url: string;
}

// budget strings look like "2M AED", "8k/month", "1.4 million" — pull the leading number + k/m suffix.
function parseBudgetToMaxPrice(budget: string): number | null {
  const m = budget.match(/([\d,]+(?:\.\d+)?)\s*(k|m|million)?/i);
  if (!m) return null;
  let value = parseFloat(m[1].replace(/,/g, ""));
  const suffix = m[2]?.toLowerCase();
  if (suffix === "k") value *= 1_000;
  else if (suffix === "m" || suffix === "million") value *= 1_000_000;
  return Math.round(value);
}

// requirement is "buy · off-plan apartment · 2BR" (joinRequirement in qualify.ts) — pull sub-parts back out.
function parseRequirement(requirement: string): { category: "rent" | "buy"; minBeds: number | null } {
  const category: "rent" | "buy" = /\brent\b/i.test(requirement) ? "rent" : "buy";
  // Bed count is always the last "·"-separated segment (e.g. "2BR" or bare "1").
  const lastPart = requirement.split("·").pop() ?? "";
  const bedsMatch = lastPart.match(/(\d+)/);
  return { category, minBeds: bedsMatch ? parseInt(bedsMatch[1], 10) : null };
}

/**
 * Search PropertyFinder for listings matching a fully-qualified lead. Returns
 * [] on any resolution/API failure — a missing match set should never break
 * the reply-generation loop, just fall back to no listings in the prompt.
 */
export async function findMatchingListings(
  q: Pick<Qualification, "budget" | "area" | "requirement">,
  limit = 3,
): Promise<ListingSummary[]> {
  if (!q.budget || !q.area || !q.requirement) return [];
  try {
    const locRes = await fetch(`${PF_API_BASE}/locations?query=${encodeURIComponent(q.area)}`);
    if (!locRes.ok) return [];
    const locations = (await locRes.json()) as { id: number }[];
    const locationId = locations[0]?.id;
    if (!locationId) return [];

    const { category, minBeds } = parseRequirement(q.requirement);
    const maxPrice = parseBudgetToMaxPrice(q.budget);

    const params = new URLSearchParams({
      location: String(locationId),
      category,
      limit: String(limit),
    });
    if (minBeds) params.set("min_beds", String(minBeds));
    if (maxPrice) params.set("max_price", String(maxPrice));

    const searchRes = await fetch(`${PF_API_BASE}/search?${params}`);
    if (!searchRes.ok) return [];
    const result = (await searchRes.json()) as { listings: ListingSummary[] };
    return result.listings ?? [];
  } catch {
    return [];
  }
}
