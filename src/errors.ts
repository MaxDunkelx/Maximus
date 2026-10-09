export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly expose: boolean;

  constructor(code: string, message: string, status: number, expose = true) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.expose = expose;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function publicFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AppError && error.expose) {
    return { code: error.code, message: error.message };
  }
  if (isAbortError(error)) {
    return { code: 'cancelled', message: 'Cancelled.' };
  }
  return { code: 'internal', message: 'The request failed.' };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
