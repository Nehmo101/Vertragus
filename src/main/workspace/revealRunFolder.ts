/**
 * S1/S4: open one run's artefact folder (`spill/`, `tasks.json`,
 * `events.jsonl`) in the OS file manager.
 *
 * A module of its own for one reason: Electron's `shell.openPath` does not
 * reject on failure. It RESOLVES with a string — empty when the path opened,
 * the OS reason when it did not. Code that awaits it and looks no further
 * turns "that folder does not exist" into a click that appears to have worked,
 * and the rule lives here so a test can hold both branches instead of a stub
 * asserting against itself.
 */

import { mainMessages } from '@shared/mainMessages'

/** The `shell.openPath` contract: resolves '' on success, a reason on failure. */
export type OpenPath = (path: string) => Promise<string>

export async function revealRunFolder(
  open: OpenPath,
  dir: string,
  locale?: string
): Promise<void> {
  const failure = await open(dir)
  // The path is in the message on purpose: the usual failure is a run whose
  // folder was never written (read-only repo, journal factory refused), and
  // the OS reason alone ("No such file or directory") does not say which one.
  // The OS reason itself stays in whatever language the OS produced it.
  if (failure) throw new Error(mainMessages(locale).runFolderNotOpened(dir, failure))
}
