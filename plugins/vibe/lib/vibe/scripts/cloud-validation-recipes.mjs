import { installedProviders } from "./provider.mjs";

/** Use only recipe data shipped with this install. Requested repository files cannot select tooling or commands. */
const provider = installedProviders()[0]?.contract;
export const cloudRecipe = provider?.data?.recipes?.cloudValidation ?? {};
export const toolingRoot = cloudRecipe.toolRoot ?? "plugins/vibe";
export const recipeProvider = provider?.name;
export const optInPath = provider?.capabilities?.recipes?.needs.find((need) => need.startsWith("repo-file:"))?.slice(10);
export const bootstrapCommand = provider?.data?.recipes?.bootstrap?.command;
