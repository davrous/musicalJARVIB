// Validate-and-retry orchestration for LLM-generated Babylon.js code
// Validates code server-side, and on failure re-prompts the LLM to fix it.

import { validateBabylonCode } from "./validator";

/**
 * A function that receives the error message and the broken code,
 * re-prompts the LLM, and returns corrected code.
 */
export type RetryFn = (
  error: string,
  previousCode: string
) => Promise<string>;

export interface ValidationResult {
  code: string;
  valid: boolean;
  error?: string;
  attempts: number;
}

/**
 * Validate Babylon.js code and retry via LLM if it fails.
 *
 * @param code - The initial code to validate
 * @param retryFn - Called on failure with (errorMessage, brokenCode) → corrected code
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @returns The final code string, whether it's valid, and total attempts made
 */
export async function validateAndRetry(
  code: string,
  retryFn: RetryFn,
  maxRetries: number = 3
): Promise<ValidationResult> {
  let currentCode = code;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const result = await validateBabylonCode(currentCode);

    if (result.valid) {
      console.log(
        `[RetryHelper] Code valid on attempt ${attempt}/${maxRetries + 1}`
      );
      return { code: currentCode, valid: true, attempts: attempt };
    }

    const errorMsg = result.error || "Unknown error";
    console.log(
      `[RetryHelper] Attempt ${attempt}/${maxRetries + 1} failed: ${errorMsg}`
    );

    // If we've used all retries, give up
    if (attempt > maxRetries) {
      console.log(
        `[RetryHelper] All ${maxRetries} retries exhausted. Giving up.`
      );
      return {
        code: currentCode,
        valid: false,
        error: errorMsg,
        attempts: attempt,
      };
    }

    // Ask the LLM to fix the code
    console.log(`[RetryHelper] Requesting LLM fix (retry ${attempt}/${maxRetries})...`);
    currentCode = await retryFn(errorMsg, currentCode);
  }

  // Should not reach here, but TypeScript needs it
  return { code: currentCode, valid: false, error: "Unexpected", attempts: maxRetries + 1 };
}
