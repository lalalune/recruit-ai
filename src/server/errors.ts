export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string, code = "bad_request") {
  return new AppError(400, code, message);
}

export function notFound(message: string, code = "not_found") {
  return new AppError(404, code, message);
}

export function conflict(message: string, code = "conflict") {
  return new AppError(409, code, message);
}

export function upstreamFailure(message: string, code = "upstream_failure") {
  return new AppError(502, code, message);
}
