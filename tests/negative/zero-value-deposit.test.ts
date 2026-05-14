import { beforeAll, describe, it } from "vitest";

import {
    ASSET,
    createTestWallet,
    expectRevert,
    fundPayerForAsset,
    type Harness,
    setupHarness,
    TEST_NSK,
    WalletError,
    withFee,
} from "../../src/harness.js";

const { alice: NSK } = TEST_NSK.negZeroValue;

describe("negative: zero-value deposit", () => {
    let h: Harness;
    let alice: Awaited<ReturnType<typeof createTestWallet>>;

    beforeAll(async () => {
        h = await setupHarness();
        await fundPayerForAsset(h, ASSET, withFee(10n));
        alice = await createTestWallet(h, NSK);
    });

    it("Wallet.deposit({ amount: 0n }) rejects", async () => {
        await expectRevert(
            alice.deposit({ amount: 0n, asset: ASSET }),
            { class: WalletError, match: /amount|zero|positive|nonzero/i },
        );
    }, 60_000);
});
