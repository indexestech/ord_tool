import { testnet } from "bitcoinjs-lib/src/networks";
import { InscriptionConfig, OrdTool, getSignatureValidator, makeKeypairFromWIF } from ".";

const deploy = {
  p: "brc-20",
  op: "deploy",
  tick: "tall",
  max: "10000000",
  lim: "1000",
};
const mint = {
  p: "brc-20",
  op: "mint",
  tick: "tall",
  amt: "1000",
};
async function deployBRC20() {
  const network = testnet;
  const config: InscriptionConfig = {
    network,
    senderAddress: "tb1qt2mnx0rgfw3kstl6t5jufsv6e58fhw5w3jga5m",
    changeRecipientAddress: "tb1q7zfpq369cn88m9xrsqrhsg7p7nklxkkexekdaw",
    feeRate: 5,
    inscriptionRequests: [
      {
        contentType: "application/json",
        content: Buffer.from(JSON.stringify(deploy), "utf-8"),
        recipientAddress: "tb1qcvts8jpr437382gp74vrsaa9du6tvceaz74p7j",
      },
    ],
  };

  const tool = new OrdTool(config);
  console.log("internal keypair WIF", tool.internalKeypair.toWIF());
  let unsignCommitPsbt = await tool.makeUnsignedCommitPsbt();
  // adding a private key in WIF (Wallet Import Format) to a .env file
  // WIF=your_private_key_in_WIF_format
  const wif = process.env.WIF;

  if (!wif) {
    throw new Error("WIF not found in .env");
  }
  const signer = makeKeypairFromWIF(wif, network);
  const signedCommitPsbt = unsignCommitPsbt.signAllInputs(signer);
  const validated = signedCommitPsbt.validateSignaturesOfAllInputs(
    getSignatureValidator(config.senderAddress)
  );

  if (!validated) {
    throw new Error("Invalid signature");
  }

  const commitTransactionId = await tool.postCommitTransaction(signedCommitPsbt);
  console.log("commit transaction id", commitTransactionId);

  await tool.waitUntilTransactionConfirm(commitTransactionId);

  await tool.postRevealTransactions();
}

async function mintBRC20() {
  const network = testnet;
  const mintReq = {
    contentType: "application/json",
    content: Buffer.from(JSON.stringify(mint), "utf-8"),
    recipientAddress: "tb1qcvts8jpr437382gp74vrsaa9du6tvceaz74p7j",
  };
  const config: InscriptionConfig = {
    network,
    senderAddress: "tb1q7zfpq369cn88m9xrsqrhsg7p7nklxkkexekdaw",
    changeRecipientAddress: "tb1qt2mnx0rgfw3kstl6t5jufsv6e58fhw5w3jga5m",
    feeRate: 5,
    inscriptionRequests: [mintReq, mintReq, mintReq, mintReq, mintReq],
  };

  const tool = new OrdTool(config);
  console.log("internal keypair WIF", tool.internalKeypair.toWIF());
  let unsignCommitPsbt = await tool.makeUnsignedCommitPsbt();
  const wif = process.env.WIF;

  if (!wif) {
    throw new Error("WIF not found in .env");
  }
  const signer = makeKeypairFromWIF(wif, network);
  const signedCommitPsbt = unsignCommitPsbt.signAllInputs(signer);
  const validated = signedCommitPsbt.validateSignaturesOfAllInputs(
    getSignatureValidator(config.senderAddress)
  );

  if (!validated) {
    throw new Error("Invalid signature");
  }

  const commitTransactionId = await tool.postCommitTransaction(signedCommitPsbt);
  console.log("commit transaction id", commitTransactionId);

  await tool.waitUntilTransactionConfirm(commitTransactionId);

  await tool.postRevealTransactions();
}

async function continueMint() {
  const network = testnet;
  const mintReq = {
    contentType: "application/json",
    content: Buffer.from(JSON.stringify(mint), "utf-8"),
    recipientAddress: "tb1qcvts8jpr437382gp74vrsaa9du6tvceaz74p7j",
  };
  const config: InscriptionConfig = {
    network,
    senderAddress: "tb1q7zfpq369cn88m9xrsqrhsg7p7nklxkkexekdaw",
    changeRecipientAddress: "tb1qt2mnx0rgfw3kstl6t5jufsv6e58fhw5w3jga5m",
    feeRate: 5,
    inscriptionRequests: [mintReq, mintReq, mintReq, mintReq, mintReq],
  };

  const tool = new OrdTool(config);
  tool.internalKeypair = makeKeypairFromWIF(
    "cVfREuij3GsozyYD7BSZmfQb6228HoERiXBTUKpVeKqm4uswVR1A",
    network
  );
  await tool.waitUntilTransactionConfirm(
    "c0ee5cf2b157c403884549e304d2e8560d76a5f0508939bf897d839b8928e1d8"
  );
  tool.commitTransactionId = "c0ee5cf2b157c403884549e304d2e8560d76a5f0508939bf897d839b8928e1d8";
  await tool.postRevealTransactions();
}

continueMint();
