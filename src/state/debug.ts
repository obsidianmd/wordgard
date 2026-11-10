export function debugString(value: any): any {
  let tp = typeof value
  if (tp == "string") return JSON.stringify(value)
  if (tp == "function") return /.*?\)/.exec(value.toString())?.[0] || value
  if (Array.isArray(value)) return `[${value.map(debugString)}]`
  return value
}
