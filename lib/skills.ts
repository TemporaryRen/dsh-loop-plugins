/**
 * Installed-skill discovery for the SKILL node's dropdown.
 *
 * The SKILL node pins one installed skill by name, so the editor needs the
 * deployment's skill catalog. Two sources are merged:
 *
 *  1. `ctx.skills.list()` — the authoritative registry when the composition
 *     mounts skill providers at the plugin's scope (CLI/headless profiles).
 *  2. The filesystem roots the shipped providers use — in the Web composition
 *     `dsh-skill-filesystem` is mounted inside each agent preset, so the host
 *     root has no registry to ask; the same directories are scanned here:
 *       `<cwd>/.dsh/skills`, `<cwd>/.agents/skills`,
 *       `~/.agents/skills`, `~/.dsh/skills`,
 *       the bundled office skills of the running installation.
 *
 * Only `SKILL.md` frontmatter is read (name + description); bodies are never
 * loaded. Results are cached by the HTTP layer, not here.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/** How many bytes of a SKILL.md are read for frontmatter. */
const FRONTMATTER_BYTES = 4096

/**
 * Strip surrounding quotes from one YAML scalar.
 */
export interface SkillFrontmatter {
  name?: string
  description?: string
  title?: string
}
export interface SkillDiscoveryOptions {
  cwd?: string
  dshHome: string
  agentsHome: string
  extraRoots?: string[]
  registryEntries?: Array<{ name: string; description?: string; source?: string; provider?: string }>
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Parse the two frontmatter fields this editor needs.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const result: SkillFrontmatter = {}
  const lines = String(text).split(/\r?\n/)
  let inFrontmatter = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '---') {
      inFrontmatter = !inFrontmatter
      continue
    }
    if (!inFrontmatter) {
      // Tolerate frontmatter-less skills: the first markdown heading names it.
      if (line.startsWith('# ')) {
        result.title = line.slice(2).trim()
        break
      }
      continue
    }
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const [, key, rawValue] = match
    if (key !== 'name' && key !== 'description') continue

    // YAML block scalars: `description: >-` / `|` put the text on the following
    // indented lines. Fold (`>`) joins lines with spaces, literal (`|`) keeps
    // the newlines, and a trailing `-` strips the final newline.
    const blockIndicator = /^([>|])[+-]?\d*$/.exec(rawValue.trim())
    if (blockIndicator !== null) {
      const literal = blockIndicator[1] === '|'
      const collected = []
      let cursor = index + 1
      for (; cursor < lines.length; cursor += 1) {
        const following = lines[cursor]
        if (following.trim() === '') {
          collected.push('')
          continue
        }
        if (!/^\s+/.test(following)) break
        collected.push(following.trim())
      }
      index = cursor - 1
      const joined = literal ? collected.join('\n') : collected.join(' ').replace(/\s+/g, ' ')
      const value = joined.trim()
      if (value !== '') result[key] = value
      continue
    }

    const value = unquote(rawValue)
    if (value !== '') result[key] = value
  }
  return result
}

/**
 * Enumerate every skill below one root directory.
 */
async function scanRoot(
  root: string,
  source: string,
): Promise<Array<{ name: string; description: string; source: string; path: string }>> {
  const found: Array<{ name: string; description: string; source: string; path: string }> = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    const file = path.join(root, entry.name, 'SKILL.md')
    try {
      const stats = await stat(file)
      if (!stats.isFile()) continue
      const handle = await readFile(file, 'utf8')
      const frontmatter = parseSkillFrontmatter(handle.slice(0, FRONTMATTER_BYTES))
      const name = typeof frontmatter.name === 'string' && frontmatter.name !== '' ? frontmatter.name : entry.name
      found.push({
        name,
        description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
        source,
        path: file,
      })
    } catch {
      // Not a skill directory (or unreadable) — skip it, discovery is best-effort.
    }
  }
  return found
}

/**
 * Build the candidate roots for one workspace.
 */
export function skillRoots({ cwd, dshHome, agentsHome, extraRoots = [] }: SkillDiscoveryOptions) {
  const roots: Array<{ root: string; source: string; rank: number }> = []
  if (typeof cwd === 'string' && cwd !== '') {
    roots.push({ root: path.join(cwd, '.dsh', 'skills'), source: 'project', rank: 0 })
    roots.push({ root: path.join(cwd, '.agents', 'skills'), source: 'project', rank: 0 })
  }
  roots.push({ root: path.join(agentsHome, 'skills'), source: 'user', rank: 1 })
  roots.push({ root: path.join(dshHome, 'skills'), source: 'user', rank: 1 })
  for (const root of extraRoots) roots.push({ root, source: 'bundled', rank: 2 })
  return roots
}

/**
 * Discover every installed skill visible to one workspace, merged by name with
 * the higher-ranked root winning (project > user > bundled).
 */
export async function discoverSkills({
  cwd,
  dshHome,
  agentsHome,
  extraRoots = [],
  registryEntries = [],
}: SkillDiscoveryOptions) {
  const merged: Map<string, { name: string; description: string; source: string; rank: number }> = new Map()

  // The registry wins when it actually reports something: it may include skills
  // that are embedded in plugins rather than stored on disk.
  for (const entry of Array.isArray(registryEntries) ? registryEntries : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name === '') continue
    merged.set(entry.name, {
      name: entry.name,
      description: typeof entry.description === 'string' ? entry.description : '',
      source: typeof entry.source === 'string' && entry.source !== '' ? entry.source : 'registry',
      rank: -1,
    })
  }

  for (const { root, source, rank } of skillRoots({ cwd, dshHome, agentsHome, extraRoots })) {
    for (const skill of await scanRoot(root, source)) {
      const existing = merged.get(skill.name)
      if (existing !== undefined && existing.rank <= rank) continue
      merged.set(skill.name, { name: skill.name, description: skill.description, source, rank })
    }
  }

  return [...merged.values()]
    .map(({ name, description, source }) => ({ name, description, source }))
    .sort((left, right) => left.name.localeCompare(right.name))
}
