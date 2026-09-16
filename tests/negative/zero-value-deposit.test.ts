import { beforeAll, describe, expect, it } from "vitest";

import {
    amt,
    ASSET,
    expectRevert,
    isWalletError,
    TEST_NSK,
    TEST_TIMEOUT,
    withFee,
} from "../../src/harness.js";
import { setupFile, type SdkWallet } from "../../src/fixture.js";

describe("negative: zero-value deposit", () => {
    let alice: SdkWallet;

    beforeAll(async () => {
        // The call never reaches the chain, but funding anyway means a
        // regression that lets it through fails on the assertion rather than
        // on an unrelated "insufficient balance".
        ({ w: { alice } } = await setupFile({
            nsks: TEST_NSK.negZeroValue,
            fund: [{ asset: ASSET, amount: withFee(10n) }],
        }));
    });

    it("wallet.deposit({ amount: 0 }) rejects", async () => {
        // Refused before any I/O, as an invalid argument naming the amount.
        const err = await expectRevert(
            alice.deposit({ amount: amt(0n), asset: ASSET }),
            { code: "INVALID_ARGUMENT" },
        );
        // Already checked by `expectRevert`; repeated to narrow `err`.
        if (!isWalletError(err, "INVALID_ARGUMENT")) throw err;
        expect(err.argument).toBe("amount");
    }, TEST_TIMEOUT.LOCAL);
});
