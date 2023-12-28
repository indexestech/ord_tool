import mempoolJS from "@mempool/mempool.js";
import bitcoin, { Network, Payment, Psbt, script as bscript, initEccLib } from "bitcoinjs-lib";
import { toXOnly, tweakInternalPubKey } from "bitcoinjs-lib/src/psbt/bip371";

import * as ecc from "tiny-secp256k1";
initEccLib(ecc);

import ECPairFactory, { ECPairAPI, ECPairInterface } from "ecpair";
import { MempoolReturn } from "@mempool/mempool.js/lib/interfaces/index";
import { AddressTxsUtxo } from "@mempool/mempool.js/lib/interfaces/bitcoin/addresses";
const ECPair = ECPairFactory(ecc);

const validator = (pubkey: Buffer, msghash: Buffer, signature: Buffer): boolean =>
  ECPair.fromPublicKey(pubkey).verify(msghash, signature);

const schnorrValidator = (pubkey: Buffer, msghash: Buffer, signature: Buffer): boolean =>
  ecc.verifySchnorr(msghash, pubkey, signature);

type InscriptionRequest = {
  receiverAddr: string;
  contentType: string;
  content: Buffer;
};

async function inscribe(
  testnet: boolean,
  payAddr: string,
  commitFee: number,
  revealFee: number,
  singleRevealTx: boolean,
  requests: InscriptionRequest[]
) {
  const client = mempoolJS({
    hostname: "mempool.space",
    network: testnet ? "testnet" : "mainnet",
  });

  const network = testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const inscriptionTxs = requests.map((r) => createInscriptioTx(network, r.contentType, r.content));

  estimateRevealTxFee(singleRevealTx, inscriptionTxs, 330, revealFee);

  let total = 0;
  for (let i = 0; i < inscriptionTxs.length; i++) {
    total += inscriptionTxs[i].value;
  }

  const utxos = await client.bitcoin.addresses.getAddressTxsUtxo({ address: payAddr });
  let balance = 0;

  for (let i = 0; i < utxos.length; i++) {
    balance += utxos[i].value;
  }

  if (total >= balance) {
    throw new Error("Insufficient Balance");
  }

  const signer = ECPair.fromWIF(process.env.PAY_PK_WIF!, network);

  let commitTx = await createCommitTx(network, payAddr, signer, commitFee, utxos, inscriptionTxs);

  // const estimatedVSize = tx.virtualSize();

  console.log("hex", commitTx.toHex());
  try {
    const txId = await client.bitcoin.transactions.postTx({ txhex: commitTx.toHex() });
    console.log("tx:", txId);
  } catch (err) {
    console.error("err", err);
  }
}
type InscriptionTx = {
  internalKey: ECPairInterface;
  payment: Payment;
  value: number;
};
function createInscriptioTx(
  network: bitcoin.networks.Network,
  contentType: string,
  content: Buffer
): InscriptionTx {
  const internalKey = ECPair.makeRandom({
    network,
  });
  const pub = toXOnly(internalKey.publicKey);
  const tweakSigner = internalKey.tweak(
    bitcoin.crypto.taggedHash("TapTweak", toXOnly(internalKey.publicKey))
  );
  const chuncks = [
    pub,
    bscript.OPS.OP_CHECKSIG,
    bscript.OPS.OP_FALSE,
    bscript.OPS.OP_IF,
    Buffer.from("ord", "utf8"),
    bscript.OPS.OP_1,
    bscript.OPS.OP_1,
    Buffer.from(contentType, "utf8"),
    bscript.OPS.OP_0,
  ];

  const maxChunkSize = 520;
  for (let i = 0; i < content.length; i += maxChunkSize) {
    let end = i + maxChunkSize;

    if (end > content.length) {
      end = content.length;
    }

    chuncks.push(content.subarray(i, end));
  }

  chuncks.push(bscript.OPS.OP_ENDIF);
  let script = bscript.compile(chuncks);

  const scriptTree = {
    output: script,
  };

  const payment = bitcoin.payments.p2tr({
    internalPubkey: pub,
    scriptTree,
    network,
  });

  return { internalKey, payment, value: 0 };
}

function estimateRevealTxFee(
  singleRevealTx: boolean,
  inscriptionTxs: InscriptionTx[],
  revealOutValue: number,
  feeRate: number
) {
  const overheadSize = 10;
  const inputSize = 41;
  const outputSize = 62;
  const emptySignature = Buffer.alloc(64);
  const emptyControlBlock = Buffer.alloc(33);
  for (let i = 0; i < inscriptionTxs.length; i++) {
    const ins = inscriptionTxs[i];
    const chunks = [emptySignature, ins.payment.output!, emptyControlBlock];
    const script = bscript.compile(chunks);
    const witnessSize = script.length + 5;
    const addOverheadSize = singleRevealTx && i === 0 ? 0 : overheadSize;
    const weight = Math.ceil((witnessSize + (inputSize + outputSize + addOverheadSize) * 4) / 4);
    ins.value = weight * feeRate + revealOutValue;
  }
}

async function createCommitTx(
  network: bitcoin.networks.Network,
  payAddr: string,
  signer: ECPairInterface,
  feeRate: number,
  utxos: AddressTxsUtxo[],
  inscriptionTxs: InscriptionTx[]
) {
  const script = bitcoin.address.toOutputScript(payAddr, network);
  const psbt = new Psbt({ network });
  //psbt.setMaximumFeeRate(500);
  let total = 0;
  for (let i = 0; i < utxos.length; i++) {
    const unspend = utxos[i];
    psbt.addInput({
      hash: unspend.txid,
      index: unspend.vout,
      witnessUtxo: { script, value: unspend.value },
    });
    total += unspend.value;
  }

  let spend = 0;
  for (let i = 0; i < inscriptionTxs.length; i++) {
    const ins = inscriptionTxs[i];
    psbt.addOutput({ address: ins.payment.address!, value: ins.value });
    spend += ins.value;
  }
  psbt.addOutput({ address: payAddr, value: 0 });

  const estimatedSize = psbt.data.inputs.reduce(
    (acc, input) => {
      return acc + input.witnessUtxo!.script.length + 41; // 41 is the approximate size of other input fields
    },
    psbt.txOutputs.reduce((acc, output) => acc + 8 + output.script.length, 10)
  );

  const estimatedFee = Math.ceil(estimatedSize * feeRate);

  const chargeIndex = psbt.txOutputs.length - 1;

  psbt.txOutputs[chargeIndex].value += total - spend - estimatedFee;
  console.log(
    "total",
    total,
    "spend",
    spend,
    "estimatedFee",
    estimatedFee,
    "return",
    psbt.txOutputs[chargeIndex].value
  );
  if (psbt.txOutputs[chargeIndex].value <= 0) {
    throw new Error("INVALID_BALANCE_TO_GAS");
  }

  psbt.signAllInputs(signer);
  psbt.finalizeAllInputs();
  const vFeeRate = psbt.getFeeRate();
  const vFee = psbt.getFee();
  const tx = psbt.extractTransaction();
  const vSize = tx.virtualSize();

  console.log("estSize:", estimatedSize, "vsize:", vSize, vFeeRate, vFee);
  return tx;
}

await inscribe(true, "tb1qp6zk2htw5scqpw7mf3nmhhkmrqdtm0z6edt5py", 50, 200, true, [
  {
    receiverAddr: "tb1qcvts8jpr437382gp74vrsaa9du6tvceaz74p7j",
    content: Buffer.from("hello world", "utf8"),
    contentType: "text/plain",
  },
]);
