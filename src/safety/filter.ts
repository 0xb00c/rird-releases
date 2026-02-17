/**
 * Safety - Task Safety Filter
 *
 * The main safety gate for all tasks entering the Rird Protocol.
 * Combines category validation and P1-P7 pattern matching.
 *
 * HARDCODED -- there is no configuration option to disable this filter.
 * Every task must pass through the filter before it can be posted,
 * bid on, or executed by any compliant agent.
 */

import { validateCategory, normalizeCategory, type AllowedCategory } from "./categories.js";
import { matchProhibitedPatterns, type PatternMatch } from "./patterns.js";
import type { ProhibitedPatternCode } from "./categories.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SafetyResult {
  /** Whether the task passed all safety checks */
  safe: boolean;
  /** List of human-readable violation descriptions */
  violations: string[];
  /** Confidence score 0-1 (1 = certain violation, 0.5 = ambiguous) */
  confidence: number;
  /** Detailed pattern matches, if any */
  patternMatches: PatternMatch[];
  /** The normalized category, if valid */
  normalizedCategory: AllowedCategory | null;
  /** Timestamp of the check */
  checkedAt: number;
}

export interface TaskInput {
  description: string;
  category: string;
  requirements?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum description length to avoid trivially empty tasks */
const MIN_DESCRIPTION_LENGTH = 10;

/** Maximum description length to prevent abuse via payload size */
const MAX_DESCRIPTION_LENGTH = 10_000;

/**
 * Confidence thresholds:
 * - Keywords alone: 0.7 (could be false positive)
 * - Regex pattern match: 0.85 (stronger signal)
 * - Both keywords + regex: 0.95 (very likely violation)
 * - Critical severity: +0.05 bonus
 */
const CONFIDENCE_KEYWORD_ONLY = 0.7;
const CONFIDENCE_PATTERN_ONLY = 0.85;
const CONFIDENCE_BOTH = 0.95;
const CONFIDENCE_CRITICAL_BONUS = 0.05;

// ---------------------------------------------------------------------------
// TaskSafetyFilter class
// ---------------------------------------------------------------------------

/**
 * Main safety filter. HARDCODED -- cannot be disabled.
 *
 * Usage:
 *   const result = taskSafetyFilter.check({ description, category });
 *   if (!result.safe) {
 *     // reject the task
 *   }
 */
class TaskSafetyFilter {
  /**
   * Run all safety checks on a task.
   * Returns a SafetyResult indicating whether the task is safe.
   */
  check(input: TaskInput): SafetyResult {
    const violations: string[] = [];
    const patternMatches: PatternMatch[] = [];
    let maxConfidence = 0;

    // Step 1: Validate description length
    const descLen = input.description.trim().length;
    if (descLen < MIN_DESCRIPTION_LENGTH) {
      violations.push(
        `Task description too short (${descLen} chars, minimum ${MIN_DESCRIPTION_LENGTH})`
      );
      maxConfidence = 1.0;
    }

    if (descLen > MAX_DESCRIPTION_LENGTH) {
      violations.push(
        `Task description too long (${descLen} chars, maximum ${MAX_DESCRIPTION_LENGTH})`
      );
      maxConfidence = 1.0;
    }

    // Step 2: Validate category
    const categoryError = validateCategory(input.category);
    const normalizedCategory = normalizeCategory(input.category);

    if (categoryError) {
      violations.push(categoryError);
      maxConfidence = Math.max(maxConfidence, 1.0);
    }

    // Step 3: Run P1-P7 pattern matching on description
    const descMatches = matchProhibitedPatterns(input.description);
    for (const match of descMatches) {
      patternMatches.push(match);
      const confidence = this.computeConfidence(match);
      maxConfidence = Math.max(maxConfidence, confidence);
      violations.push(this.formatViolation(match));
    }

    // Step 4: Also scan requirements if provided
    if (input.requirements && input.requirements.length > 0) {
      const combinedRequirements = input.requirements.join(" ");
      const reqMatches = matchProhibitedPatterns(combinedRequirements);
      for (const match of reqMatches) {
        // Avoid duplicate pattern codes
        const alreadyFound = patternMatches.some((m) => m.code === match.code);
        if (!alreadyFound) {
          patternMatches.push(match);
          const confidence = this.computeConfidence(match);
          maxConfidence = Math.max(maxConfidence, confidence);
          violations.push(this.formatViolation(match, "requirements"));
        }
      }
    }

    const safe = violations.length === 0;

    return {
      safe,
      violations,
      confidence: safe ? 0 : Math.min(maxConfidence, 1.0),
      patternMatches,
      normalizedCategory,
      checkedAt: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Quick boolean check -- does the task pass safety?
   */
  isSafe(input: TaskInput): boolean {
    return this.check(input).safe;
  }

  /**
   * Check only the description (without category validation).
   * Useful for scanning free text before a full task is constructed.
   */
  scanDescription(description: string): PatternMatch[] {
    return matchProhibitedPatterns(description);
  }

  /**
   * Get a list of all prohibited pattern codes.
   */
  getProhibitedCodes(): ProhibitedPatternCode[] {
    return ["P1", "P2", "P3", "P4", "P5", "P6", "P7"];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private computeConfidence(match: PatternMatch): number {
    const hasKeywords = match.matchedKeywords.length > 0;
    const hasPatterns = match.matchedPatterns.length > 0;

    let base: number;
    if (hasKeywords && hasPatterns) {
      base = CONFIDENCE_BOTH;
    } else if (hasPatterns) {
      base = CONFIDENCE_PATTERN_ONLY;
    } else {
      base = CONFIDENCE_KEYWORD_ONLY;
    }

    if (match.severity === "critical") {
      base += CONFIDENCE_CRITICAL_BONUS;
    }

    return Math.min(base, 1.0);
  }

  private formatViolation(match: PatternMatch, source: string = "description"): string {
    const parts: string[] = [
      `[${match.code}] ${match.name} (${match.severity}) detected in ${source}`,
    ];

    if (match.matchedKeywords.length > 0) {
      parts.push(`keywords: ${match.matchedKeywords.slice(0, 3).join(", ")}`);
    }
    if (match.matchedPatterns.length > 0) {
      parts.push(`patterns: ${match.matchedPatterns.slice(0, 2).join(", ")}`);
    }

    return parts.join(" -- ");
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * The global task safety filter instance.
 * HARDCODED -- no way to bypass or disable.
 */
export const taskSafetyFilter = new TaskSafetyFilter();

/**
 * Also export the class for typing purposes.
 */
export { TaskSafetyFilter };
