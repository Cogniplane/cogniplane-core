export class GithubConnectionNotConfiguredError extends Error {
  constructor(message = "GitHub App integration is not configured.") {
    super(message);
  }
}
