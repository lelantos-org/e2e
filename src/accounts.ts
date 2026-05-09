// Anvil deterministic accounts (mnemonic = "test test … junk"). Index
// → role mapping is hard-baked across the stack.

export interface AnvilAccount {
    address: string;
    privateKey: string;
}

/// acct[0]. Runs `forge script DeployTest.s.sol`. Funded by anvil with
/// 10000 ETH; pays gas for verifier + masp + token deployment. Address
/// is hard-coded into DeployTest.s.sol's `tx.origin` defaults for treasury
/// + owner.
export const DEPLOYER: AnvilAccount = {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
};

/// acct[1]. Signs every relayer-submitted `transact` tx. The relayer
/// container reads `RELAYER_CHAIN_<id>_SIGNER_KEY` from this private
/// key; the contract requires `pubInputs.relayer == msg.sender`, so
/// every test bundle pins this address as `relayerAddress`.
export const RELAYER: AnvilAccount = {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
};

/// acct[2]. ERC20 source for deposits. Tests mint mDAI here and
/// `approve(MASP, _)` so `MASP.transact` can pull funds during the
/// deposit leg. Bundle's `payerAddress` = this.
export const PAYER: AnvilAccount = {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

/// acct[3]. ERC20 destination for withdraws. The contract transfers
/// `publicOut` units of the asset to this address on the withdraw leg.
/// Used as `recipientAddress` everywhere a non-deployer EOA is needed.
export const RECIPIENT: AnvilAccount = {
    address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    privateKey: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
};
