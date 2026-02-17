/**
 * Safety - Prohibited Task Pattern Matching
 *
 * Implements pattern detection for prohibited task types P1 through P7.
 * Each pattern has regex patterns and keyword lists. The matcher scans
 * a task description and returns all matching violations.
 *
 * HARDCODED safety rules -- cannot be disabled via configuration.
 */

import type { ProhibitedPatternCode } from "./categories.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PatternMatch {
  code: ProhibitedPatternCode;
  name: string;
  matchedKeywords: string[];
  matchedPatterns: string[];
  severity: "high" | "critical";
}

interface PatternDefinition {
  code: ProhibitedPatternCode;
  name: string;
  severity: "high" | "critical";
  keywords: string[];
  regexPatterns: RegExp[];
}

// ---------------------------------------------------------------------------
// Pattern definitions P1-P7
// ---------------------------------------------------------------------------

const PATTERN_DEFINITIONS: PatternDefinition[] = [
  {
    code: "P1",
    name: "individual_targeting",
    severity: "critical",
    keywords: [
      "dox",
      "doxx",
      "doxing",
      "doxxing",
      "personal information",
      "home address",
      "phone number",
      "social security",
      "find person",
      "locate person",
      "identify person",
      "real name",
      "real identity",
    ],
    regexPatterns: [
      // Email patterns embedded in task descriptions
      /find\s+(info|information|details|data)\s+(about|on|for)\s+\w+/i,
      // Targeting named individuals
      /target(ing)?\s+(the\s+)?(person|individual|user|account)/i,
      // Looking up personal identifiers
      /look\s*up\s+(someone|person|individual|their)/i,
      // SSN or ID number references
      /\b(ssn|social\s*security|national\s*id|passport\s*number)\b/i,
    ],
  },
  {
    code: "P2",
    name: "system_targeting",
    severity: "critical",
    keywords: [
      "vulnerability",
      "exploit",
      "zero-day",
      "0day",
      "buffer overflow",
      "sql injection",
      "xss attack",
      "remote code execution",
      "rce",
      "privilege escalation",
      "brute force",
      "penetration test",
      "pentest",
      "hack into",
      "break into",
      "gain access",
      "unauthorized access",
      "bypass security",
      "bypass authentication",
      "ddos",
      "denial of service",
    ],
    regexPatterns: [
      // URL/IP targeting
      /attack\s+(the\s+)?(server|site|website|system|network|host)/i,
      // Port scanning
      /scan\s+(ports?|network|vulnerabilit)/i,
      // Specific IP targeting
      /target\s+\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i,
      // Exploit development
      /develop\s+(an?\s+)?(exploit|payload|shellcode)/i,
      // System compromise
      /compromise\s+(the\s+)?(server|system|network|database)/i,
    ],
  },
  {
    code: "P3",
    name: "deceptive_content",
    severity: "high",
    keywords: [
      "pretend to be",
      "impersonate",
      "impersonation",
      "pose as",
      "disguise as",
      "fake identity",
      "fake profile",
      "catfish",
      "social engineering",
      "phishing",
      "spear phishing",
      "whaling",
      "deepfake",
      "misinformation",
      "disinformation",
    ],
    regexPatterns: [
      // Impersonation instructions
      /act\s+as\s+(if\s+you\s+are|though\s+you\s+are)\s+(a|an|the)\s+(bank|support|admin|employee|official)/i,
      // Phishing content
      /create\s+(a\s+)?(phishing|fake|fraudulent)\s+(email|page|site|login)/i,
      // Deceptive communication
      /send\s+(a\s+)?(message|email)\s+(pretending|claiming|saying)\s+(to be|you are)/i,
      // Fake documents
      /forge\s+(a\s+)?(document|certificate|id|identity|signature)/i,
    ],
  },
  {
    code: "P4",
    name: "bulk_automated_actions",
    severity: "high",
    keywords: [
      "flood",
      "spam",
      "mass email",
      "mass message",
      "bulk send",
      "bot army",
      "botnet",
      "automated accounts",
      "fake accounts",
      "sockpuppet",
      "astroturf",
      "vote manipulation",
      "review bombing",
      "brigading",
    ],
    regexPatterns: [
      // Large volume requests
      /send\s+(over\s+)?\d{3,}\s+(emails?|messages?|requests?|comments?)/i,
      // Mass creation
      /create\s+(over\s+)?\d{3,}\s+(accounts?|profiles?|posts?)/i,
      // Flooding
      /(flood|overwhelm|overload)\s+(the\s+)?(server|site|inbox|system)/i,
      // Spam campaigns
      /(spam|blast|bomb)\s+(the\s+)?(comments?|reviews?|inbox|forum)/i,
      // Numeric bulk indicators
      /\b(1000|10000|100000|1k|10k|100k)\s+(times|emails?|messages?|requests?)\b/i,
    ],
  },
  {
    code: "P5",
    name: "credential_harvesting",
    severity: "critical",
    keywords: [
      "steal password",
      "harvest credentials",
      "credential stuffing",
      "keylogger",
      "key logger",
      "password dump",
      "password list",
      "credential dump",
      "crack password",
      "password cracking",
      "brute force login",
      "rainbow table",
      "hash cracking",
    ],
    regexPatterns: [
      // Credential extraction
      /extract\s+(the\s+)?(passwords?|credentials?|login\s+info|tokens?)/i,
      // Login attacks
      /try\s+(all|every|each|multiple|different)\s+(passwords?|credentials?|combinations?)/i,
      // Credential interception
      /intercept\s+(the\s+)?(login|password|credential|session|token)/i,
      // Account takeover
      /take\s*over\s+(the\s+)?(account|profile|session)/i,
      // Scraping credentials
      /scrape\s+(passwords?|credentials?|login|accounts?)\s+from/i,
    ],
  },
  {
    code: "P6",
    name: "illegal_content",
    severity: "critical",
    keywords: [
      "child exploitation",
      "csam",
      "illegal drugs",
      "drug synthesis",
      "drug manufacturing",
      "weapon manufacturing",
      "bomb making",
      "explosive device",
      "bioweapon",
      "chemical weapon",
      "terrorism",
      "terrorist",
      "human trafficking",
      "money laundering",
      "counterfeit currency",
    ],
    regexPatterns: [
      // Weapons/explosives
      /how\s+to\s+(make|build|create|assemble)\s+(a\s+)?(bomb|explosive|weapon|gun|firearm)/i,
      // Drug production
      /how\s+to\s+(make|synthesize|produce|manufacture)\s+(meth|cocaine|heroin|fentanyl|drugs?)/i,
      // Illegal services
      /(hire|find)\s+(a\s+)?(hitman|assassin|killer)/i,
      // Document fraud
      /create\s+(a\s+)?(counterfeit|fake|forged)\s+(money|currency|bill|passport|visa)/i,
    ],
  },
  {
    code: "P7",
    name: "surveillance",
    severity: "high",
    keywords: [
      "stalk",
      "stalking",
      "track location",
      "track person",
      "follow person",
      "monitor person",
      "spy on",
      "spying",
      "wiretap",
      "eavesdrop",
      "profile person",
      "build dossier",
      "background check without consent",
      "covert monitoring",
    ],
    regexPatterns: [
      // Location tracking
      /track\s+(the\s+)?(location|movements?|whereabouts)\s+(of\s+)?(a\s+)?(person|individual|user|someone)/i,
      // Covert monitoring
      /monitor\s+(the\s+)?(person|individual|user|someone|their)\s+(without|covertly|secretly)/i,
      // Social media stalking
      /follow\s+(all|every)\s+(post|activity|movement|action)\s+(of|by|from)/i,
      // Building profiles
      /build\s+(a\s+)?(profile|dossier|file)\s+(on|about|of)\s+(a\s+)?(person|individual|someone)/i,
      // Surveillance equipment
      /install\s+(a\s+)?(tracker|camera|microphone|spyware|malware)\s+(on|in)/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/**
 * Scan a task description for prohibited patterns.
 * Returns all patterns that matched.
 */
export function matchProhibitedPatterns(description: string): PatternMatch[] {
  if (!description || description.trim().length === 0) {
    return [];
  }

  const normalizedDesc = description.toLowerCase();
  const matches: PatternMatch[] = [];

  for (const pattern of PATTERN_DEFINITIONS) {
    const matchedKeywords: string[] = [];
    const matchedPatterns: string[] = [];

    // Check keywords
    for (const keyword of pattern.keywords) {
      if (normalizedDesc.includes(keyword.toLowerCase())) {
        matchedKeywords.push(keyword);
      }
    }

    // Check regex patterns
    for (const regex of pattern.regexPatterns) {
      const match = description.match(regex);
      if (match) {
        matchedPatterns.push(match[0]);
      }
    }

    // If any keyword or pattern matched, record the violation
    if (matchedKeywords.length > 0 || matchedPatterns.length > 0) {
      matches.push({
        code: pattern.code,
        name: pattern.name,
        matchedKeywords,
        matchedPatterns,
        severity: pattern.severity,
      });
    }
  }

  return matches;
}

/**
 * Check if a specific pattern code matches.
 */
export function matchesPattern(
  description: string,
  code: ProhibitedPatternCode
): PatternMatch | null {
  const all = matchProhibitedPatterns(description);
  return all.find((m) => m.code === code) || null;
}

/**
 * Get all pattern definitions (read-only).
 */
export function getPatternDefinitions(): readonly PatternDefinition[] {
  return PATTERN_DEFINITIONS;
}
