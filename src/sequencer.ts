import { BaseSequencer } from "vitest/node";

/**
 * Deterministic file ordering, by path.
 *
 * Vitest's default sequencer sorts by file size on a cold cache and by cached
 * duration once `node_modules/.vite` exists, so the same suite runs in one
 * order in CI and another locally. Every file shares a single anvil, MASP and
 * indexer DB, which makes that difference visible: a shared-state regression
 * reproduces in CI and not on the machine debugging it, or the reverse.
 *
 * Every assertion in this suite is a delta, so no file depends on running in a
 * particular position. This exists so that a failure is reproducible in the
 * order it first appeared.
 */
export default class PathSequencer extends BaseSequencer {
    async sort(files: Parameters<BaseSequencer["sort"]>[0]) {
        return [...files].sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0));
    }
}
