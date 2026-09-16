// Anvil deterministic accounts (mnemonic = "test test … junk").

export interface AnvilAccount {
    address: string;
    privateKey: string;
}

// acct[0]. Runs `forge script DeployTest.s.sol`. Hard-coded into the script's
// `tx.origin` defaults for treasury + owner.
export const DEPLOYER: AnvilAccount = {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
};

// acct[1]. Signs every relayer transaction, all of which are
// `Bundler.execute` calls. It is the Bundler's operator, not what proofs bind:
// the pool sees the Bundler as `msg.sender`, so wallets pin the Bundler's
// address as `relayerAddress` (`env.bundlerAddress`).
export const RELAYER: AnvilAccount = {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
};

// acct[2]. ERC20 source for deposits.
export const PAYER: AnvilAccount = {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

// acct[3]. ERC20 destination for withdraws.
export const RECIPIENT: AnvilAccount = {
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    privateKey: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
};

// acct[5]. Owns and operates a second Bundler that no relayer runs, so
// `tests/bundler-mixed.test.ts` can submit a proof bound to the stack's Bundler
// through another one. acct[4] is left for a second relayer's signer.
export const OTHER_BUNDLER_OWNER: AnvilAccount = {
    address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    privateKey: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
};
