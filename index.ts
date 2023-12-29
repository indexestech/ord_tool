import fs from "fs";

import mempoolJS from "@mempool/mempool.js";
import bitcoin, {
  Network,
  Payment,
  Psbt,
  TxOutput,
  script as bscript,
  initEccLib,
} from "bitcoinjs-lib";
import { toXOnly, tweakInternalPubKey } from "bitcoinjs-lib/src/psbt/bip371";

import * as ecc from "tiny-secp256k1";
initEccLib(ecc);

import ECPairFactory, { ECPairAPI, ECPairInterface } from "ecpair";
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
const log = Date.now() + ".json";

class Log {
  file: string;
  constructor() {
    this.file = Date.now() + ".json";
  }

  logParams(
    testnet: boolean,
    payAddr: string,
    commitFee: number,
    revealFee: number,
    singleRevealTx: boolean,
    requests: InscriptionRequest[]
  ) {
    if (fs.existsSync(this.file)) {
      // one command must have only log
      throw new Error("file:" + this.file + "exists");
    }
    fs.writeFileSync(
      this.file,
      JSON.stringify({
        param: { testnet, payAddr, commitFee, revealFee, singleRevealTx, requests },
      })
    );
  }

  logRevealTxs(
    txs: {
      wif: string;
      address: string;
      value: number;
      vsize: number;
      feeRate: number;
      gas: number;
    }[]
  ) {
    if (!fs.existsSync(this.file)) {
      throw new Error("no initial file");
    }
    const data = JSON.parse(fs.readFileSync(this.file, "utf-8"));
    data.revealTxs = txs;
    fs.writeFileSync(this.file, JSON.stringify(data));
  }

  logCommitTx(tx: {
    total: number;
    spend: number;
    charge: number;
    fee: number;
    prevOutputs: TxOutput[];
    outputs: {
      address: string;
    };
  }) {}
}

async function inscribe(
  testnet: boolean,
  payAddr: string,
  commitFee: number,
  revealFee: number,
  singleRevealTx: boolean,
  requests: InscriptionRequest[]
) {
  const params = {
    testnet,
    payAddr,
    commitFee,
    revealFee,
    singleRevealTx,
    requests,
  };

  JSON.stringify(params, null, 2);
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

type OrdData = {
  contentType: string;
  content: Buffer;
};

/**
 * @param pub Buffer pubkey of reveal
 * @param data OrdData data to be inscribed
 * @returns Buffer taproot script
 *
 */
export function buildOrdScript(pub: Buffer, data: OrdData): Buffer {
  const chuncks = [
    pub,
    bscript.OPS.OP_CHECKSIG,
    bscript.OPS.OP_FALSE,
    bscript.OPS.OP_IF,
    Buffer.from("ord", "utf8"),
    1,
    1,
    Buffer.from(data.contentType, "utf8"),
    0,
  ];

  const maxChunkSize = 520;
  for (let i = 0; i < data.content.length; i += maxChunkSize) {
    let end = i + maxChunkSize;

    if (end > data.content.length) {
      end = data.content.length;
    }

    chuncks.push(data.content.subarray(i, end));
  }

  chuncks.push(bscript.OPS.OP_ENDIF);
  return bscript.compile(chuncks);
}

type OrdRequest = {
  data: OrdData;
  dst: string;
};

// minimal value
const DUST = 330;

/**
 * @param network Network bitcoin network, mainnet, testnet
 * @param data OrdData data to be inscribed
 * @param dst string address of inscription sending
 * @param feeRate number fee rate for reveal tx
 */
export function createRevealTx(
  network: bitcoin.networks.Network,
  data: OrdData,
  dst: string,
  feeRate: number
): { payment: Payment; internalKeypair: ECPairInterface } {
  // prepare internal keypair for inscription
  const internalKeypair = ECPair.makeRandom({ network });
  const internalPub = toXOnly(internalKeypair.publicKey);

  // build p2tr payment
  const scriptTree = {
    output: buildOrdScript(internalPub, data),
  };
  const payment = bitcoin.payments.p2tr({ pubkey: internalPub, scriptTree, network });

  // estimate fee

  const estTx = new bitcoin.Transaction();

  // make fake input
  estTx.addInput(Buffer.alloc(32), 0);
  estTx.addOutput(Buffer.alloc(32), DUST);
  estTx.
}

function createInscriptioTx(
  network: bitcoin.networks.Network,
  contentType: string,
  content: Buffer
): InscriptionTx {
  const internalKey = ECPair.makeRandom({
    network,
  });
  console.log("☞☞☞☞☞☞internal key network", network, "WIF:", internalKey.toWIF());
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
    1,
    1,
    Buffer.from(contentType, "utf8"),
    0,
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
  const {
    psbt: withoutFeePsbt,
    total,
    spend,
  } = createPSBT(true, network, payAddr, signer, 0, utxos, inscriptionTxs);

  const tx0 = withoutFeePsbt.extractTransaction();
  const vsize = tx0.virtualSize();

  const fee = vsize * feeRate;
  const chargeFee = total - spend - fee;

  if (chargeFee < 0) {
    throw new Error("INSUFFICE_BALANCE_FOR_GAS");
  }

  const { psbt } = createPSBT(false, network, payAddr, signer, chargeFee, utxos, inscriptionTxs);
  console.log("🚩🚩🚩🚩blance", total, "spend", spend, "fee", fee);
  return psbt.extractTransaction();
}

function createPSBT(
  estimated: boolean,
  network: bitcoin.networks.Network,
  payAddr: string,
  signer: ECPairInterface,
  chargeFee: number,
  utxos: AddressTxsUtxo[],
  inscriptionTxs: InscriptionTx[]
): { psbt: Psbt; total: number; spend: number } {
  const script = bitcoin.address.toOutputScript(payAddr, network);
  const psbt = new Psbt({ network });
  // psbt.setMaximumFeeRate(500);
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

  if (estimated) {
    psbt.addOutput({ address: payAddr, value: 0 });
  } else {
    if (chargeFee > 330) {
      psbt.addOutput({ address: payAddr, value: chargeFee });
    }
  }

  psbt.signAllInputs(signer);
  psbt.finalizeAllInputs();
  return { psbt, total, spend };
}

await inscribe(true, "tb1qp6zk2htw5scqpw7mf3nmhhkmrqdtm0z6edt5py", 50, 200, true, [
  {
    receiverAddr: "tb1qcvts8jpr437382gp74vrsaa9du6tvceaz74p7j",
    content: Buffer.from("hello world", "utf8"),
    contentType: "text/plain",
  },
]);
