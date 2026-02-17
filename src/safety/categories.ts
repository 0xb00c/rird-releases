/**
 * Safety - Task Category Definitions
 *
 * Defines allowed and prohibited task categories for the Rird Protocol.
 * Every task must declare a category. Tasks in prohibited categories are
 * rejected at the protocol level before reaching any agent.
 */

// ---------------------------------------------------------------------------
// Allowed categories
// ---------------------------------------------------------------------------

/**
 * Categories that agents may freely accept and execute.
 */
export const ALLOWED_CATEGORIES = [
  "research",
  "monitoring",
  "content",
  "code",
  "data",
  "automation",
  "verification",
] as const;

export type AllowedCategory = (typeof ALLOWED_CATEGORIES)[number];

/**
 * Human-readable descriptions for each allowed category.
 */
export const CATEGORY_DESCRIPTIONS: Record<AllowedCategory, string> = {
  research: "Information gathering, analysis, summarization from public sources",
  monitoring: "Watching for changes, alerts, uptime checks on public services",
  content: "Writing, editing, translating, formatting text and media",
  code: "Writing, reviewing, debugging, testing software code",
  data: "Processing, transforming, analyzing structured datasets",
  automation: "Orchestrating multi-step workflows across permitted services",
  verification: "Fact-checking, proof verification, output validation",
};

// ---------------------------------------------------------------------------
// Prohibited pattern identifiers
// ---------------------------------------------------------------------------

/**
 * Prohibited pattern codes P1-P7.
 * These are referenced by the pattern matcher in patterns.ts.
 */
export const PROHIBITED_PATTERNS = {
  P1: "individual_targeting",
  P2: "system_targeting",
  P3: "deceptive_content",
  P4: "bulk_automated_actions",
  P5: "credential_harvesting",
  P6: "illegal_content",
  P7: "surveillance",
} as const;

export type ProhibitedPatternCode = keyof typeof PROHIBITED_PATTERNS;
export type ProhibitedPatternName = (typeof PROHIBITED_PATTERNS)[ProhibitedPatternCode];

/**
 * Human-readable descriptions for each prohibited pattern.
 */
export const PROHIBITED_DESCRIPTIONS: Record<ProhibitedPatternCode, string> = {
  P1: "Tasks that target specific individuals by name, email, or personal identifier",
  P2: "Tasks that target systems via URL, IP, or attempt to find vulnerabilities",
  P3: "Tasks that involve impersonation or deceptive identity",
  P4: "Tasks requesting bulk automated actions (flooding, mass operations, spam)",
  P5: "Tasks aimed at harvesting credentials, passwords, or login information",
  P6: "Tasks requesting generation or distribution of illegal content",
  P7: "Tasks involving surveillance, tracking, or profiling of individuals",
};

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

/**
 * Check if a category string is in the allowed set.
 */
export function isAllowedCategory(category: string): category is AllowedCategory {
  return (ALLOWED_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Validate a task category. Returns an error message if invalid, null if valid.
 */
export function validateCategory(category: string): string | null {
  if (!category || category.trim().length === 0) {
    return "Task category is required";
  }

  const normalized = category.trim().toLowerCase();

  if (!isAllowedCategory(normalized)) {
    const allowed = ALLOWED_CATEGORIES.join(", ");
    return `Category "${category}" is not allowed. Permitted categories: ${allowed}`;
  }

  return null;
}

/**
 * Normalize a category string to its canonical form.
 * Returns the canonical category or null if not recognized.
 */
export function normalizeCategory(category: string): AllowedCategory | null {
  const normalized = category.trim().toLowerCase();
  if (isAllowedCategory(normalized)) {
    return normalized;
  }

  // Try common aliases
  const aliases: Record<string, AllowedCategory> = {
    search: "research",
    lookup: "research",
    investigate: "research",
    watch: "monitoring",
    alert: "monitoring",
    write: "content",
    edit: "content",
    translate: "content",
    develop: "code",
    program: "code",
    debug: "code",
    process: "data",
    transform: "data",
    analyze: "data",
    automate: "automation",
    workflow: "automation",
    check: "verification",
    validate: "verification",
    verify: "verification",
  };

  return aliases[normalized] || null;
}

/**
 * Get the description for a category.
 */
export function getCategoryDescription(category: AllowedCategory): string {
  return CATEGORY_DESCRIPTIONS[category];
}

/**
 * Get the description for a prohibited pattern.
 */
export function getProhibitedDescription(code: ProhibitedPatternCode): string {
  return PROHIBITED_DESCRIPTIONS[code];
}
