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
