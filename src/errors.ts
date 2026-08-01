export class HttpError extends Error {
  constructor(
    public status: number,
    public error: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
