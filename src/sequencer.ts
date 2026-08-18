import { BaseSequencer } from "vitest/node";

/**
 * Deterministic file ordering.
 *
 * Vitest's default sequencer sorts by file size on a cold cache and by cached
 * duration once `node_modules/.vite` exists — so the same suite runs in one
 * order in CI and a different one locally. Every file here shares a single
 * anvil, MASP and indexer DB, which makes that difference visible: a
 * shared-state regression reproduces in CI and not on the machine debugging
 * it, or vice versa.
 *
 * Assertions in this suite are all deltas, so no file *depends* on running in
 * a particular position — this exists so that when something does break, the
 * order it broke in is the order you get when you re-run it.
 */
export default class PathSequencer extends BaseSequencer {
    async sort(files: Parameters<BaseSequencer["sort"]>[0]) {
        return [...files].sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0));
    }
}
