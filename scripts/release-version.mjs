/**
 * The tag guard: refuse a release tag that disagrees with `package.json`.
 *
 * Everything downstream of a tag push takes its version from `package.json`,
 * not from the tag: electron-builder names the artifacts from it
 * (`Vertragus-<version>-setup.exe`) and writes it into `latest.yml`, which is
 * the file every installed stable app compares itself against. The tag is only
 * the ref the release object hangs on. If the two disagree, pushing `v1.0.0`
 * produces a release tagged `v1.0.0` that contains 0.1.0 artifacts and a
 * `latest.yml` claiming 0.1.0 — and every future stable release has to climb
 * out of that hole, because electron-updater compares against the published
 * number, not the tag. There is no way to repair that after publication except
 * by shipping a higher version.
 *
 * So this script runs FIRST in release.yml, before the draft release shell is
 * created, and asserts three things about a tag push:
 *
 *   1. the ref is a stable tag — `vX.Y.Z`, no prerelease suffix. `main`
 *      prereleases are produced by the workflow itself (`X.Y.<run>-main…`);
 *      a hand-pushed `v1.0.0-rc.1` would land on the `latest` channel and
 *      offer itself to every stable installation.
 *   2. `tag.slice(1)` equals the package version — the two sources must agree
 *      because only one of them (package.json) actually names the artifacts.
 *   3. the package version has patch 0 (`X.Y.0`). The main-channel arithmetic
 *      in release.yml ADDS the run number to the patch, so the patch of the
 *      committed version is a BASE, not a count. A base of anything but 0
 *      drifts upward forever (0.1.7 + run 400 = 0.1.407, and the next release
 *      would have to start from there).
 *
 * On a branch push (`GITHUB_REF_TYPE=branch`) there is nothing to check and
 * the script exits 0 — which is why the guard job carries no `if:` condition
 * in release.yml: a skipped job would block its dependents on main.
 *
 * Usage: `node scripts/release-version.mjs` (reads GITHUB_REF_TYPE/_NAME).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A stable release tag: `v` plus three numbers, no prerelease, no build id. */
export const STABLE_TAG = /^v\d+\.\d+\.\d+$/

/** The committed version is a base for the main-channel arithmetic: patch 0. */
export const PATCH_BASE_VERSION = /^\d+\.\d+\.0$/

/**
 * Pure rule check. Returns a human-readable problem, or null when the tag may
 * be released. Free of I/O so scripts/releaseVersion.test.ts can table over
 * every rule without a repository around it.
 *
 * @param {string} tag the pushed ref name, e.g. `v1.0.0`
 * @param {string} version the `version` field of package.json
 * @returns {string | null}
 */
export function tagVersionProblem(tag, version) {
  if (!STABLE_TAG.test(tag)) {
    return (
      `tag "${tag}" is not a stable release tag (expected vX.Y.Z, no prerelease suffix). ` +
      'Prereleases are published automatically from main on the `main` update channel; ' +
      'only stable versions are tagged by hand.'
    )
  }
  if (tag.slice(1) !== version) {
    return (
      `tag "${tag}" and package.json version "${version}" disagree. ` +
      'Artifacts and latest.yml are named from package.json, so the two must match: ' +
      `either bump package.json to ${tag.slice(1)} and merge that first, or delete the tag ` +
      `and push v${version} instead.`
    )
  }
  if (!PATCH_BASE_VERSION.test(version)) {
    return (
      `package.json version "${version}" must have patch 0 (X.Y.0). ` +
      'release.yml derives main-channel prereleases by ADDING the run number to this patch, ' +
      'so a non-zero base drifts upward with every build. Release X.Y.0, then open main at X.(Y+1).0.'
    )
  }
  return null
}

function main() {
  if (process.env.GITHUB_REF_TYPE !== 'tag') {
    console.log('[release-version] not a tag — nothing to check.')
    return 0
  }
  const tag = process.env.GITHUB_REF_NAME ?? ''
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const problem = tagVersionProblem(tag, version)
  if (problem) {
    console.error(`::error::${problem}`)
    return 1
  }
  console.log(`[release-version] ok — tag ${tag} matches package.json ${version}.`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
