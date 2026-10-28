#!/usr/bin/env bash
# create-verify-profile.sh — build/refresh an isolated DSH profile that boots
# the workspace copy of dsh-loop-manager by link, for local verification.
#
# What it does (idempotent — every run converges to the same state):
#   1. (Re)creates a custom profile named `loopverify` from the shipped `web`
#      template inside $DSH_HOME (default: /tmp/dsh-loop-verify-home, NEVER the
#      live ~/.dsh profile used by the Electron app).
#   2. Adds `"dsh-loop-manager": "link:<PLUGIN_DIR>"` to the profile
#      package.json dependencies.
#   3. Appends `dsh-loop-manager` to `dsh.profile.bundles` so its
#      cordis.patch.yml (insert row id=loop-manager) is part of the layer stack.
#   4. Runs `pnpm install` in the profile directory (link install; the harness
#      resolves @deepseek-ai/* imports of linked plugins through its profile
#      resolution layer, so no host packages need to be installed here).
#
# Last line of stdout is the profile directory (machine-readable).
#
# Environment overrides:
#   DSH_HOME    isolated harness home        (default /tmp/dsh-loop-verify-home)
#   PROFILE     custom profile name          (default loopverify)
#   PLUGIN_DIR  package to link              (default this workspace)
#   DSH_BIN     dsh executable               (default: dsh on PATH)
#   PNPM_BIN    pnpm executable              (default: pnpm on PATH)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/.." && pwd)"

DSH_HOME="${DSH_HOME:-/tmp/dsh-loop-verify-home}"
PROFILE="${PROFILE:-loopverify}"
PLUGIN_DIR="${PLUGIN_DIR:-$WORKSPACE}"
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
PNPM_BIN="${PNPM_BIN:-$(command -v pnpm || true)}"

log() { printf 'create-verify-profile: %s\n' "$*" >&2; }
die() { printf 'create-verify-profile: ERROR: %s\n' "$*" >&2; exit 1; }

# ---- safety rails: never build over the live desktop profile -----------------
if [ "$PROFILE" = "desktop" ] || [ "$PROFILE" = "web" ]; then
  die "refusing to use profile '$PROFILE' (shipped/desktop profiles are off-limits to this script; use a custom name like loopverify)"
fi
case "$DSH_HOME" in
  /Users/*/.dsh | /Users/*/.dsh/ | "$HOME/.dsh" | "$HOME/.dsh/")
    die "refusing to use the live DSH home '$DSH_HOME'; set DSH_HOME to an isolated directory such as /tmp/dsh-loop-verify-home"
    ;;
esac
[ -n "$DSH_BIN" ] || die "dsh not found on PATH (set DSH_BIN=/opt/homebrew/bin/dsh)"
[ -n "$PNPM_BIN" ] || die "pnpm not found on PATH (set PNPM_BIN=/opt/homebrew/bin/pnpm)"
[ -f "$PLUGIN_DIR/package.json" ] || die "PLUGIN_DIR '$PLUGIN_DIR' has no package.json"

log "building linked TypeScript plugin"
npm --prefix "$PLUGIN_DIR" run build

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
export DSH_HOME

mkdir -p "$DSH_HOME/profiles"
log "harness home: $DSH_HOME"
log "profile:      $PROFILE ($PROFILE_DIR)"
log "plugin:       $PLUGIN_DIR (link)"

# ---- 1. create/replace the profile from the shipped web template -------------
# --from-default-profile always stages a fresh copy and swaps it in, so this
# step alone converges the template half. --dump-config exits after composing.
if ! "$DSH_BIN" --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null 2>"$PROFILE_DIR.dump-config.stderr"; then
  log "dsh --from-default-profile web failed; stderr:"
  cat "$PROFILE_DIR.dump-config.stderr" >&2 || true
  rm -f "$PROFILE_DIR.dump-config.stderr"
  die "profile creation failed"
fi
rm -f "$PROFILE_DIR.dump-config.stderr"
[ -f "$PROFILE_DIR/package.json" ] || die "profile was created without a package.json at $PROFILE_DIR"

# ---- 2+3. converge dependencies and the bundle list -------------------------
# Done in node so the edit is a real JSON parse/serialize (no sed fragility)
# and preserves whatever the template shipped.
node - "$PROFILE_DIR/package.json" "$PLUGIN_DIR" <<'NODE'
const fs = require('node:fs');
const [pkgPath, pluginDir] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const spec = `link:${pluginDir}`;
manifest.dependencies = { ...(manifest.dependencies ?? {}), 'dsh-loop-manager': spec };

manifest.dsh = manifest.dsh ?? {};
manifest.dsh.profile = manifest.dsh.profile ?? {};
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
if (!bundles.includes('@deepseek-ai/dsh-base')) bundles.unshift('@deepseek-ai/dsh-base');
if (!bundles.includes('@deepseek-ai/dsh-web-app')) bundles.splice(1, 0, '@deepseek-ai/dsh-web-app');
if (!bundles.includes('dsh-loop-manager')) bundles.push('dsh-loop-manager');
manifest.dsh.profile.bundles = bundles;

fs.writeFileSync(pkgPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

# ---- 4. install the link ----------------------------------------------------
log "pnpm install in $PROFILE_DIR"
if ! ( cd "$PROFILE_DIR" && "$PNPM_BIN" install --prefer-offline --reporter=append-only ); then
  die "pnpm install failed in $PROFILE_DIR"
fi

# ---- verify the outcome ------------------------------------------------------
node - "$PROFILE_DIR" "$PLUGIN_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [profileDir, pluginDir] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
if (manifest.dependencies?.['dsh-loop-manager'] !== `link:${pluginDir}`) {
  throw new Error('package.json dependency was not converged');
}
if (!manifest.dsh?.profile?.bundles?.includes('dsh-loop-manager')) {
  throw new Error('dsh.profile.bundles does not list dsh-loop-manager');
}
const link = path.join(profileDir, 'node_modules', 'dsh-loop-manager');
if (!fs.existsSync(link)) throw new Error(`missing link install at ${link}`);
const real = fs.realpathSync(link);
const expected = fs.realpathSync(pluginDir);
if (real !== expected) throw new Error(`link points at ${real}, expected ${expected}`);
NODE

log "OK: profile ready (bundles: $(node -p "JSON.parse(require('node:fs').readFileSync('$PROFILE_DIR/package.json','utf8')).dsh.profile.bundles.join(', ')") )"
# machine-readable result on stdout (last line)
printf '%s\n' "$PROFILE_DIR"
