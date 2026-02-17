/**
 * Safety - LLM-Based Task Classifier
 *
 * For ambiguous tasks that pattern matching alone cannot confidently
 * classify, this module provides an LLM-based secondary review.
 *
 * If no LLM is configured, falls back to pattern matching results.
 */

import { matchProhibitedPatterns, type PatternMatch } from "./patterns.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  /** Whether the task is considered safe */
  safe: boolean;
  /** Confidence 0-1 */
  confidence: number;
  /** Reasoning from the classifier */
  reasoning: string;
  /** Method used: "llm" or "pattern_fallback" */
  method: "llm" | "pattern_fallback";
  /** Pattern matches found (always populated regardless of method) */
  patternMatches: PatternMatch[];
}

/**
 * Interface for an LLM classifier backend.
 * Implementations can wrap Claude, local models, or any other LLM.
 */
export interface LlmClassifier {
  /**
   * Classify a task description for safety.
   * Should return safe=true/false with reasoning.
   */
  classify(prompt: string): Promise<LlmClassifierResponse>;
}

export interface LlmClassifierResponse {
  safe: boolean;
  confidence: number;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

const CLASSIFICATION_PROMPT_TEMPLATE = `You are a safety classifier for an AI agent task marketplace.

Evaluate whether the following task description is safe for AI agents to execute.

A task is UNSAFE if it involves any of:
- P1: Targeting specific individuals (doxxing, personal info lookup)
- P2: Attacking computer systems (hacking, exploits, DDoS)
- P3: Deceptive content (impersonation, phishing, fake identities)
- P4: Bulk automated abuse (spam, flooding, mass fake accounts)
- P5: Credential harvesting (stealing passwords, keyloggers)
- P6: Illegal content (weapons, drugs, CSAM, terrorism)
- P7: Surveillance (stalking, tracking individuals, spyware)

A task is SAFE if it involves:
- Legitimate research from public sources
- Monitoring public services or data
- Content creation (writing, editing, translating)
- Software development and code review
- Data processing and analysis
- Workflow automation on authorized services
- Fact-checking and verification

TASK DESCRIPTION:
---
{TASK_DESCRIPTION}
---

Respond in exactly this JSON format:
{
  "safe": true or false,
  "confidence": 0.0 to 1.0,
  "reasoning": "Brief explanation of your decision"
}`;

// ---------------------------------------------------------------------------
// Task classifier
// ---------------------------------------------------------------------------

/**
 * Classify a task for safety using an LLM with pattern-matching fallback.
 *
 * @param description - The task description to classify
 * @param classifier - Optional LLM classifier instance
 * @returns Classification result
 */
export async function classifyTask(
  description: string,
  classifier?: LlmClassifier
): Promise<ClassificationResult> {
  // Always run pattern matching first
  const patternMatches = matchProhibitedPatterns(description);

  // If pattern matching found critical violations, do not bother with LLM
  const hasCritical = patternMatches.some((m) => m.severity === "critical");
  if (hasCritical) {
    return {
      safe: false,
      confidence: 0.95,
      reasoning: buildPatternReasoning(patternMatches),
      method: "pattern_fallback",
      patternMatches,
    };
  }

  // If LLM classifier is available, use it for ambiguous cases
  if (classifier) {
    try {
      const prompt = CLASSIFICATION_PROMPT_TEMPLATE.replace(
        "{TASK_DESCRIPTION}",
        description
      );

      const llmResult = await classifier.classify(prompt);

      // Cross-validate: if patterns found violations but LLM says safe,
      // trust the patterns (conservative approach)
      if (patternMatches.length > 0 && llmResult.safe) {
        return {
          safe: false,
          confidence: Math.max(0.7, llmResult.confidence),
          reasoning:
            `LLM classified as safe but pattern matching found violations: ` +
            buildPatternReasoning(patternMatches) +
            `. Taking conservative approach.`,
          method: "llm",
          patternMatches,
        };
      }

      return {
        safe: llmResult.safe,
        confidence: llmResult.confidence,
        reasoning: llmResult.reasoning,
        method: "llm",
        patternMatches,
      };
    } catch (err) {
      console.error(`[safety/classifier] LLM classification failed: ${err}`);
      // Fall through to pattern-based fallback
    }
  }

  // Fallback: use pattern matching results
  if (patternMatches.length > 0) {
    return {
      safe: false,
      confidence: computePatternConfidence(patternMatches),
      reasoning: buildPatternReasoning(patternMatches),
      method: "pattern_fallback",
      patternMatches,
    };
  }

  // No violations found by any method
  return {
    safe: true,
    confidence: 0.6, // Lower confidence since LLM was not available
    reasoning: "No prohibited patterns detected. Classified as safe by pattern matching.",
    method: "pattern_fallback",
    patternMatches: [],
  };
}

/**
 * Parse a raw LLM response string into a structured response.
 * Useful when the LLM returns raw text instead of structured JSON.
 */
export function parseLlmResponse(raw: string): LlmClassifierResponse {
  try {
    // Try to extract JSON from the response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return {
        safe: Boolean(parsed.safe),
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided",
      };
    }
  } catch {
    // JSON parsing failed
  }

  // Heuristic parsing if JSON extraction fails
  const lowerRaw = raw.toLowerCase();
  const isSafe = lowerRaw.includes("safe: true") || lowerRaw.includes('"safe": true');
  const isUnsafe = lowerRaw.includes("safe: false") || lowerRaw.includes('"safe": false');

  return {
    safe: isSafe && !isUnsafe,
    confidence: 0.5, // Low confidence for heuristic parsing
    reasoning: `Heuristic parse of LLM output: ${raw.slice(0, 200)}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPatternReasoning(matches: PatternMatch[]): string {
  const parts = matches.map((m) => {
    const triggers: string[] = [];
    if (m.matchedKeywords.length > 0) {
      triggers.push(`keywords: ${m.matchedKeywords.slice(0, 3).join(", ")}`);
    }
    if (m.matchedPatterns.length > 0) {
      triggers.push(`patterns: ${m.matchedPatterns.slice(0, 2).join(", ")}`);
    }
    return `${m.code}/${m.name} (${triggers.join("; ")})`;
  });

  return `Prohibited patterns detected: ${parts.join(". ")}`;
}

function computePatternConfidence(matches: PatternMatch[]): number {
  let maxConf = 0;

  for (const m of matches) {
    const hasKeywords = m.matchedKeywords.length > 0;
    const hasPatterns = m.matchedPatterns.length > 0;

    let conf = 0.6;
    if (hasKeywords && hasPatterns) conf = 0.95;
    else if (hasPatterns) conf = 0.85;
    else if (hasKeywords) conf = 0.7;

    if (m.severity === "critical") conf = Math.min(conf + 0.05, 1.0);

    maxConf = Math.max(maxConf, conf);
  }

  return maxConf;
}

/**
 * Get the classification prompt template (for inspection/testing).
 */
export function getPromptTemplate(): string {
  return CLASSIFICATION_PROMPT_TEMPLATE;
}
