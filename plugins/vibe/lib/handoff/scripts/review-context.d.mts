export const reviewDoctrine: string;
export function formatReviewContext(ticket: string, readPath: string, rulingPath?: string): string;
interface ReviewBinding { ticket: string; version: number; sha256: string; criteria: string[]; rulings: string[] }
export function boundReviewContext(brief: string, worktree: string, orchDir?: string, ticket?: string): ReviewBinding;
export function reviewQuestions(result: Record<string, unknown>, binding: ReviewBinding): Record<string, unknown>;
