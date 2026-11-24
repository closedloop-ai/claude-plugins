/** Every string in a run log, whatever its shape, so the worker's final message can be found. */
export function logText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(logText).join("\n");
  if (value && typeof value === "object") return Object.values(value).map(logText).join("\n");
  return "";
}
