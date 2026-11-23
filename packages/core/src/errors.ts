export class PathExistsError extends Error {
  constructor(public readonly path: string) {
    super(`Path already exists: ${path}`);
    this.name = "PathExistsError";
  }
}

export class NotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`Path not found: ${path}`);
    this.name = "NotFoundError";
  }
}

export class InvalidPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPathError";
  }
}

/** A storage provider refused or failed a request; status is the provider's HTTP status. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
