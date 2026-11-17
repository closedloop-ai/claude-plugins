/** The line a writer brief carries for the lead binding. */
export function providerLine(binding: unknown): string;
export function briefProviderLine(prompt: string): string | null;
export function briefProviderProblem(prompt: string, binding: unknown, options?: { required?: boolean }): string | null;
export const WRITER_BRIEF: RegExp;
