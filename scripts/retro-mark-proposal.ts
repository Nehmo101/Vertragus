/**
 * Proposal-Status-Pflege für den retros-Daten-Branch: setzt das Front-Matter
 * `status:` eines Proposals um und verweist optional auf den umsetzenden
 * Commit. Reiner Datei-Rewrite, kein Netzwerk — der PR gegen `retros` bleibt
 * das Review-Gate.
 *
 *   pnpm run retro:mark-proposal -- --dir /pfad/zum/retros-checkout \
 *     --slug worker-completion-diff-guard --status done [--commit 2027e72]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { parseProposalStatus } from '../src/shared/retroAnalysis'

const ALLOWED_STATUS = ['proposed', 'accepted', 'done', 'rejected'] as const

function fail(message: string): never {
  console.error(`Fehler: ${message}`)
  process.exit(2)
}

const argv = process.argv.slice(2)
const { values } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: {
    dir: { type: 'string' },
    slug: { type: 'string' },
    status: { type: 'string' },
    commit: { type: 'string' }
  }
})

if (!values.dir) fail('--dir <retros-checkout> ist erforderlich.')
if (!values.slug) fail('--slug <proposal-slug> ist erforderlich.')
const status = values.status ?? ''
if (!(ALLOWED_STATUS as readonly string[]).includes(status)) {
  fail(`--status muss einer von ${ALLOWED_STATUS.join(', ')} sein.`)
}

const proposalsDir = join(values.dir, 'proposals')
if (!existsSync(proposalsDir)) fail(`Kein proposals/-Verzeichnis unter ${values.dir}.`)

const fileName = readdirSync(proposalsDir).find(
  (name) => name.endsWith('.md') && name.replace(/^\d{4}-\d{2}-\d{2}-/, '') === `${values.slug}.md`
)
if (!fileName) fail(`Kein Proposal mit Slug "${values.slug}" gefunden.`)

const path = join(proposalsDir, fileName)
const content = readFileSync(path, 'utf8')
const frontMatter = /^---\r?\n[\s\S]*?\r?\n---/.exec(content)
if (!frontMatter) fail(`${fileName} hat kein Front-Matter — Datei nicht angefasst.`)

const previous = parseProposalStatus(content)
let updatedFrontMatter = frontMatter[0]
if (/^status:.*$/m.test(updatedFrontMatter)) {
  updatedFrontMatter = updatedFrontMatter.replace(/^status:.*$/m, `status: ${status}`)
} else {
  updatedFrontMatter = updatedFrontMatter.replace(/^---/, `---\nstatus: ${status}`)
}
if (values.commit) {
  updatedFrontMatter = /^implementedIn:.*$/m.test(updatedFrontMatter)
    ? updatedFrontMatter.replace(/^implementedIn:.*$/m, `implementedIn: ${values.commit}`)
    : updatedFrontMatter.replace(/\r?\n---$/, `\nimplementedIn: ${values.commit}\n---`)
}

writeFileSync(path, content.replace(frontMatter[0], updatedFrontMatter), 'utf8')
console.log(`${fileName}: status ${previous} → ${status}${values.commit ? ` (implementedIn: ${values.commit})` : ''}`)
