/**
 * Unit tests for installed-skill discovery (`lib/skills.js`) — the catalog that
 * backs the SKILL node's dropdown.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverSkills, parseSkillFrontmatter, skillRoots } from '../lib/skills.js'

/**
 * Create one skill directory with a SKILL.md.
 * @param {string} root - skills root.
 * @param {string} dirName - directory name.
 * @param {string} frontmatter - frontmatter body (without the --- fences).
 */
async function writeSkill(root: string, dirName: string, frontmatter: string) {
  await mkdir(join(root, dirName), { recursive: true })
  await writeFile(join(root, dirName, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# Body\n`, 'utf8')
}

test('parseSkillFrontmatter reads name and description, quoted or plain', () => {
  assert.deepEqual(
    parseSkillFrontmatter('---\nname: office-docx\ndescription: "Create and edit .docx files."\n---\n'),
    { name: 'office-docx', description: 'Create and edit .docx files.' },
  )
  assert.deepEqual(parseSkillFrontmatter("---\nname: 'demo'\ndescription: plain text\n---\n"), {
    name: 'demo',
    description: 'plain text',
  })
  // A frontmatter-less skill falls back to its first heading.
  assert.deepEqual(parseSkillFrontmatter('# Word documents\n'), { title: 'Word documents' })
})

test('parseSkillFrontmatter folds YAML block scalars (>, |) used by real SKILL.md files', () => {
  const folded = parseSkillFrontmatter(
    '---\nname: demo\ndescription: >-\n  first line\n  second line\n  third line\n---\n',
  )
  assert.deepEqual(folded, { name: 'demo', description: 'first line second line third line' })

  const literal = parseSkillFrontmatter('---\nname: demo\ndescription: |\n  line one\n  line two\n---\n')
  assert.equal(literal.description, 'line one\nline two')

  // Trailing keys after the block still parse, and a blank line inside the
  // block does not end it.
  const mixed = parseSkillFrontmatter('---\nname: demo\ndescription: >\n  alpha\n\n  beta\nversion: 1\n---\n')
  assert.deepEqual(mixed, { name: 'demo', description: 'alpha beta' })
})

test('skillRoots ranks project roots above user roots above bundled', () => {
  const roots = skillRoots({
    cwd: '/work/app',
    dshHome: '/home/u/.dsh',
    agentsHome: '/home/u/.agents',
    extraRoots: ['/bundle'],
  })
  assert.deepEqual(
    roots.map((entry) => entry.source),
    ['project', 'project', 'user', 'user', 'bundled'],
  )
  assert.equal(roots[0].root, '/work/app/.dsh/skills')
  assert.equal(roots[2].root, '/home/u/.agents/skills')
})

test('discoverSkills merges roots by name with the higher rank winning', async () => {
  const base = await mkdtemp(join(tmpdir(), 'loop-skills-'))
  const agentsHome = join(base, 'agents')
  const dshHome = join(base, 'dsh')
  const cwd = join(base, 'project')
  const bundled = join(base, 'bundled')

  await writeSkill(join(agentsHome, 'skills'), 'shared', 'name: shared\ndescription: user version')
  await writeSkill(join(agentsHome, 'skills'), 'only-user', 'name: only-user\ndescription: user only')
  await writeSkill(join(cwd, '.dsh', 'skills'), 'shared', 'name: shared\ndescription: project version')
  await writeSkill(bundled, 'office-demo', 'name: office-demo\ndescription: bundled')

  const skills = await discoverSkills({ cwd, dshHome, agentsHome, extraRoots: [bundled] })
  const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]))

  assert.equal(byName.shared.description, 'project version', 'project root wins over the user root')
  assert.equal(byName['only-user'].source, 'user')
  assert.equal(byName['office-demo'].source, 'bundled')
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ['office-demo', 'only-user', 'shared'],
  )
})

test('registry entries are merged and win over filesystem duplicates', async () => {
  const base = await mkdtemp(join(tmpdir(), 'loop-skills-reg-'))
  await writeSkill(join(base, 'agents', 'skills'), 'demo', 'name: demo\ndescription: from disk')
  const skills = await discoverSkills({
    cwd: '',
    dshHome: join(base, 'dsh'),
    agentsHome: join(base, 'agents'),
    extraRoots: [] as any[],
    registryEntries: [
      { name: 'demo', description: 'from registry', source: 'runtime' },
      { name: 'embedded-only', description: 'plugin skill', source: 'runtime' },
    ],
  })
  const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]))
  assert.equal(byName.demo.description, 'from registry')
  assert.equal(byName['embedded-only'].source, 'runtime')
})

test('a missing skills root yields no entries and never throws', async () => {
  const skills = await discoverSkills({ cwd: '', dshHome: '/nonexistent/dsh', agentsHome: '/nonexistent/agents' })
  assert.deepEqual(skills, [])
})
