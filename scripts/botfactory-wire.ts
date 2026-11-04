/**
 * Wires one BotFactory identity onto the local superagent profile.
 * The WeCom Secret stays in the environment and is not printed.
 *
 *   node --experimental-transform-types scripts/botfactory-wire.ts --dry-run examples/botfactory/trade-followup.yml
 */
import { runBotfactory } from '../src/botfactory/wire.ts'

process.exit(await runBotfactory({ argv: process.argv.slice(2) }))
