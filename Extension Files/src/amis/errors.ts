/**
 * Typed AMIS portal integration, parsing, and persistence errors.
 */

export type AmisErrorCode =
  | 'NOT_ON_AMIS_TAB'
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'COURSE_NOT_FOUND'
  | 'NO_CLASSES_FOUND'
  | 'EXHAUSTED_CAPACITY'
  | 'MALFORMED_RESPONSE'
  | 'NETWORK_ERROR';

export interface AmisErrorOptions {
  statusCode?: number;
  details?: unknown;
}

/**
 * Structured error thrown across the AMIS bridge, API client, parser, and snapshot loader.
 */
export class AmisError extends Error {
  readonly code: AmisErrorCode;
  readonly statusCode: number | undefined;
  readonly details: unknown;

  constructor(code: AmisErrorCode, message: string, options?: AmisErrorOptions) {
    super(message);
    this.name = 'AmisError';
    this.code = code;
    this.statusCode = options?.statusCode;
    this.details = options?.details;
  }
}

/**
 * Type guard checking whether an unknown thrown value is an AmisError instance.
 */
export function isAmisError(err: unknown): err is AmisError {
  return err instanceof AmisError;
}
