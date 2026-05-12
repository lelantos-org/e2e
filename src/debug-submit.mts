// Standalone debug: reproduces the submitIntent revert with full error data.

import { ethers } from "ethers";
import { Poseidon, Jubjub, buildDeposit, signPermit2Witness, computePiHash } from "@lelantos-org/sdk";

// payerKey = anvil default key #2 (per stack/deploy.sh FUND_RECIPIENT)
const PAYER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const RPC = "http://localhost:8545";
const FUND_RECIPIENT = "0x39A48ff447632f9D5A6D5d4f3a6a2152509D1792";

async function readAddresses() {
    const { execSync } = await import("node:child_process");
    const out = execSync("docker run --rm -v stack_addresses:/a alpine cat /a/addresses.env").toString();
    const env: Record<string, string> = {};
    for (const line of out.split("\n")) {
        const m = line.match(/^([^=]+)=(.*)$/);
        if (m) env[m[1]] = m[2];
    }
    return env;
}

async function main() {
    const addrs = await readAddresses();
    console.log("MASP=", addrs.MASP);
    console.log("PERMIT2=", addrs.PERMIT2);
    console.log("TOKEN_2=", addrs.TOKEN_2);

    const provider = new ethers.JsonRpcProvider(RPC);
    const payer = new ethers.Wallet(PAYER_KEY, provider);
    console.log("payer=", await payer.getAddress());

    // Mint + approve via direct calls
    const erc20 = new ethers.Contract(
        addrs.TOKEN_2,
        [
            "function mint(address to, uint256 amt) external",
            "function approve(address spender, uint256 amount) returns (bool)",
            "function balanceOf(address) view returns (uint256)",
        ],
        payer,
    );
    await (await erc20.mint(await payer.getAddress(), 10000n * 10n ** 18n)).wait();
    await (await erc20.approve(addrs.PERMIT2, ethers.MaxUint256)).wait();
    console.log("payer bal=", (await erc20.balanceOf(await payer.getAddress())).toString());

    // Build deposit
    const P = await Poseidon.build();
    const J = await Jubjub.build();
    let seed = 0xdeadbeefn;
    const rng = (): bigint => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 128n) - 1n);
        return seed | 1n;
    };

    const built = buildDeposit({
        P,
        J,
        chainId: 31337n,
        publicAssetId: 2n,
        publicIn: 100n,
        payer: await payer.getAddress(),
        recipient: FUND_RECIPIENT,
        output0: { rho: rng(), rcm: rng(), rcv: rng(), rcvDep: rng(), aux: { esk: rng(), fmdR: rng() } },
        output1Pad: { rho: rng(), rcm: rng(), rcv: rng(), rcvDep: rng() },
    } as any);

    console.log("intent.cvDep0=", built.intent.cvDep0);
    console.log("intent.cvDep1=", built.intent.cvDep1);
    console.log("intent.rcvTotal=", built.intent.rcvTotal);

    const piHash = computePiHash(built.intent, built.aux);
    const nonce = BigInt(Date.now()) << 8n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await signPermit2Witness({
        signer: payer,
        chainId: 31337n,
        spender: addrs.MASP,
        token: addrs.TOKEN_2,
        maxTotal: 200n * 10n ** 18n,
        nonce,
        deadline,
        piHash,
        permit2Address: addrs.PERMIT2,
    });
    console.log("sig.signature=", sig.signature);

    const masp = new ethers.Contract(
        addrs.MASP,
        [
            "function submitIntent((uint64 chainId,uint64 publicAssetId,uint64 publicIn,address payer,address recipient,bytes32[2] outCm,uint256[2] cvDep0,uint256[2] cvDep1,uint256 rcvTotal) d, (uint256 nonce,uint256 deadline,uint256 maxTotal,bytes signature) sig, (uint256 clueRx,uint256 clueRy,uint256 ephPubX,uint256 ephPubY,bytes ciphertext)[2] aux) returns (uint256)",
        ],
        payer,
    );

    try {
        const tx = await masp.submitIntent.staticCall(
            [
                built.intent.chainId,
                built.intent.publicAssetId,
                built.intent.publicIn,
                built.intent.payer,
                built.intent.recipient,
                built.intent.outCm,
                built.intent.cvDep0,
                built.intent.cvDep1,
                built.intent.rcvTotal,
            ],
            [sig.nonce, sig.deadline, sig.maxTotal, sig.signature],
            built.aux.map((a: any) => [a.clueRx, a.clueRy, a.ephPubX, a.ephPubY, ethers.hexlify(a.ciphertext)]),
        );
        console.log("OK id=", tx);
    } catch (e: any) {
        console.log("REVERT data=", e.data);
        console.log("REVERT info=", JSON.stringify(e.info, null, 2));
        console.log("REVERT short=", e.shortMessage);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
