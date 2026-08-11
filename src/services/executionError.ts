/**
 * ExecutionError — custom error with a machine-readable code used across the
 * execution, delegation, and chat routes.
 *
 * Kept in its own file so gas estimation and transaction finalization can throw
 * execution-level errors without creating a circular dependency with execution.ts.
 */

export class ExecutionError extends Error {
  code: string;
  /** When true, the caller should allow the user to sign the transaction manually. */
  fallbackToManual?: boolean;
  constructor(message: string, code: string, fallbackToManual?: boolean) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
    this.fallbackToManual = fallbackToManual;
  }
}
