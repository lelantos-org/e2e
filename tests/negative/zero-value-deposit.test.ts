import { beforeAll, describe, it } from "vitest";

import {
    amt,
    ASSET,
    expectRevert,
    TEST_NSK,
    TEST_TIMEOUT,
    WalletError,
    withFee,
} from "../../src/harness.js";
import { setupFile, type SdkWallet } from "../../src/fixture.js";

const { alice: NSK } = TEST_NSK.negZeroValue;

describe("negative: zero-value deposit", () => {
    let alice: SdkWallet;

    beforeAll(async () => {
        // The call never reaches the chain, but fund anyway so a regression
        // that *does* let it through fails on the assertion rather than on an
        // unrelated "insufficient balance".
        ({ w: { alice } } = await setupFile({
            nsks: TEST_NSK.negZeroValue,
            fund: [{ asset: ASSET, amount: withFee(10n) }],
        }));
    });

    it("Wallet.deposit({ amount: 0n }) rejects", async () => {
        await expectRevert(
            alice.deposit({ amount: amt(0n), asset: ASSET }),
            { class: WalletError, match: /amount|zero|positive|nonzero/i },
        );
    }, TEST_TIMEOUT.LOCAL);
});
