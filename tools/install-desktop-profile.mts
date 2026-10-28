#!/usr/bin/env node
/**
 * Install (or revert) the dsh-loop-manager plugin in the DSH Desktop profile.
 *
 * The desktop profile is owned exclusively by the Electron app, so the public
 * `dsh plugin` CLI refuses it. The supported development channel is a
 * `link:` dependency, which is exactly what this script sets up:
 *
 *   1. declares `"dsh-loop-manager": "link:<workspace>"` in the profile
 *      package.json dependencies (a `link:` spec, never `file:`);
 *   2. appends `dsh-loop-manager` to `dsh.profile.bundles`;
 *   3. symlinks the workspace package into the profile's node_modules;
 *   4. waits for the running app's HMR profile watch to recompose the tree and
 *      verifies with `GET /loop-manager/api/state`.
 *
 * Every file it touches is backed up next to the original, and `--revert`
 * restores the profile to its pre-install state, so the operation is
 * reversible without the CLI.
 *
 * Usage:
 *   node dist/tools/install-desktop-profile.mjs            # install + verify
 *   node dist/tools/install-desktop-profile.mjs --dry-run  # print the plan
 *   node dist/tools/install-desktop-profile.mjs --revert   # restore backups
 *
 * Environment:
 *   DSH_HOME   defaults to ~/.dsh
 *   DSH_URL    defaults to http://127.0.0.1:58042 (the app's Web GUI)
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '../..')
const PACKAGE_NAME = 'dsh-loop-manager'
const PROFILE_NAME = process.env.DSH_PROFILE ?? 'desktop'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_NAME)
const MANIFEST = join(PROFILE_DIR, 'package.json')
const LINK_PATH = join(PROFILE_DIR, 'node_modules', PACKAGE_NAME)
const BACKUP = join(PROFILE_DIR, 'package.json.loop-manager.bak')
const APP_URL = (process.env.DSH_URL ?? 'http://127.0.0.1:58042').replace(/\/+$/, '')

const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has('--dry-run')
const REVERT = args.has('--revert')

/** Fail loudly with a prefixed message. @param {string} message - reason. */
function die(message: string): never {
  console.error(`[loop-manager] ${message}`)
  process.exit(1)
}

/** @param {string} message - progress line. */
function say(message: string) {
  console.log(`[loop-manager] ${message}`)
}

/** Read the profile manifest. @returns {{raw: string, manifest: any}} */
function readManifest(): { raw: string; manifest: any } {
  if (!existsSync(MANIFEST)) die(`profile manifest not found: ${MANIFEST}`)
  const raw = readFileSync(MANIFEST, 'utf8')
  try {
    return { raw, manifest: JSON.parse(raw) }
  } catch (error: any) {
    die(`profile manifest is not valid JSON: ${String(error)}`)
  }
}

/** Current state of the profile's bundled link, for idempotent apply/revert. @returns {{linked: boolean, target: string|null, foreign: boolean}} */
function linkState(): { linked: boolean; target: string | null; foreign: boolean } {
  const stat = lstatSync(LINK_PATH, { throwIfNoEntry: false })
  if (stat === undefined) return { linked: false, target: null, foreign: false }
  if (!stat.isSymbolicLink()) return { linked: true, target: null, foreign: true }
  const target = readlinkSync(LINK_PATH)
  return { linked: true, target, foreign: resolve(dirname(LINK_PATH), target) !== WORKSPACE }
}

/** Install the link + manifest declarations. */
function apply() {
  const { manifest } = readManifest()
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const dependencies = manifest.dependencies ?? {}
  const spec = `link:${WORKSPACE}`
  const needsManifest = dependencies[PACKAGE_NAME] !== spec || !bundles.includes(PACKAGE_NAME)
  const state = linkState()

  say(`workspace: ${WORKSPACE}`)
  say(`profile:   ${PROFILE_DIR}`)
  say(`dependency ${PACKAGE_NAME}: ${dependencies[PACKAGE_NAME] ?? '(absent)'} -> ${spec}`)
  say(
    `bundles:   ${bundles.length} entries, ${bundles.includes(PACKAGE_NAME) ? 'already lists' : 'will append'} ${PACKAGE_NAME}`,
  )
  say(
    `node_modules link: ${state.linked ? (state.foreign ? `foreign target ${state.target}` : `already -> ${state.target}`) : 'absent'}`,
  )

  if (state.foreign) die(`${LINK_PATH} exists and is not a link to this workspace; refusing to overwrite it`)

  if (DRY_RUN) {
    say('dry run: no files changed')
    return
  }

  if (needsManifest) {
    if (!existsSync(BACKUP)) {
      copyFileSync(MANIFEST, BACKUP)
      say(`backed up manifest -> ${BACKUP}`)
    }
    const next = structuredClone(manifest)
    next.dependencies = { ...dependencies, [PACKAGE_NAME]: spec }
    next.dsh = {
      ...next.dsh,
      profile: {
        ...next.dsh?.profile,
        bundles: bundles.includes(PACKAGE_NAME) ? bundles : [...bundles, PACKAGE_NAME],
      },
    }
    writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    say('updated profile manifest')
  }

  if (!state.linked) {
    symlinkSync(WORKSPACE, LINK_PATH, 'dir')
    say(`linked ${LINK_PATH} -> ${WORKSPACE}`)
  }
}

/** Restore the profile to its pre-install state. */
function revert() {
  const state = linkState()
  say(`profile: ${PROFILE_DIR}`)
  if (DRY_RUN) {
    say('dry run: no files changed')
    return
  }
  if (state.linked && !state.foreign) {
    unlinkSync(LINK_PATH)
    say(`removed ${LINK_PATH}`)
  } else if (state.foreign) {
    say(`left foreign link untouched: ${LINK_PATH} -> ${state.target}`)
  }
  if (existsSync(BACKUP)) {
    copyFileSync(BACKUP, MANIFEST)
    unlinkSync(BACKUP)
    say('restored profile manifest from backup')
  } else {
    // No backup: strip our declarations in place, keeping everything else.
    const { manifest } = readManifest()
    if (manifest.dependencies?.[PACKAGE_NAME] !== undefined) delete manifest.dependencies[PACKAGE_NAME]
    const bundles = manifest.dsh?.profile?.bundles
    if (Array.isArray(bundles)) {
      manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME)
    }
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    say('stripped plugin declarations from the profile manifest (no backup existed)')
  }
}

/** Poll the running app until the host half answers, or time out. @returns {Promise<boolean>} */
async function verify(): Promise<boolean> {
  // The health route is the only unfenced one: the app's main API requires the
  // browser cookie minted from its process launch token, which a shell cannot
  // present. A 200 here proves the profile recomposition mounted the plugin.
  const url = `${APP_URL}/loop-manager/api/ping`
  const deadline = Date.now() + 30_000
  let lastError = 'no attempt'
  say(`waiting for HMR to mount the plugin: GET ${url}`)
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      const text = await response.text()
      if (response.ok) {
        say(`verified: ${response.status} ${text.slice(0, 200)}`)
        return true
      }
      lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`
    } catch (error: any) {
      lastError = String(error?.cause?.code ?? error?.message ?? error)
    }
    await new Promise((done) => setTimeout(done, 1000))
  }
  say(`not mounted yet (${lastError})`)
  say(
    'the profile watch may be waiting for the next recomposition — restart the app or toggle any plugin in the Plugins page, then re-run this check',
  )
  return false
}

const command = REVERT ? revert : apply
command()
if (!DRY_RUN && !REVERT) {
  const ok = await verify()
  say(
    ok
      ? 'done — refresh the Web GUI to see the Loop Manager row in the left sidebar'
      : 'installed, but the host half did not answer in time',
  )
  process.exit(ok ? 0 : 2)
}
