export class ConfidentialContentError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(
      "Draft body contains confidential markers: " + reasons.join("; ") +
        ". The exec must confirm before saving to Gmail.",
    );
    this.name = "ConfidentialContentError";
    this.reasons = reasons;
  }
}
