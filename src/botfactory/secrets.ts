/** Keeps credential values out of BotFactory files and printed lines. */

/** Removes credential-shaped values before a line is printed. */
export function scrub(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 6 || !/SECRET|PASSWORD|TOKEN/i.test(key)) continue
    out = out.split(value).join('[redacted]')
  }
  return out
}

export function assertNoSecret(text: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 6 || !/SECRET|PASSWORD|TOKEN/i.test(key)) continue
    if (text.includes(value)) throw new Error('Refusing to write or print a credential')
  }
}
