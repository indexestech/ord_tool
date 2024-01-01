import bitcoin, { Payment, Psbt, Transaction, script as bscript, initEccLib } from "bitcoinjs-lib";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371";

import { LEAF_VERSION_TAPSCRIPT } from "bitcoinjs-lib/src/payments/bip341";

import * as ecc from "tiny-secp256k1";
initEccLib(ecc);

import { Taptree } from "bitcoinjs-lib/src/types";
import ECPairFactory, { ECPairInterface } from "ecpair";
const ECPair = ECPairFactory(ecc);

export const validateEcdsaSignature = (
  pubkey: Buffer,
  messageHash: Buffer,
  signature: Buffer
): boolean => ECPair.fromPublicKey(pubkey).verify(messageHash, signature);

export const validateSchnorrSignature = (
  pubkey: Buffer,
  messageHash: Buffer,
  signature: Buffer
): boolean => ecc.verifySchnorr(messageHash, pubkey, signature);

// Minimal transaction value to avoid MIN_TX_VALUE limit
const MIN_TX_VALUE = 330;

export type InscriptionConfig = {
  senderAddress: string;
  network: bitcoin.networks.Network;
  changeRecipientAddress: string;
  feeRate: number;
  inscriptionRequests: InscriptionRequest[];
};

export type InscriptionRequest = {
  recipientAddress: string;
  contentType: string;
  content: Buffer;
};

export type RevealTransaction = {
  inscriptionAddress: string;
  transactionValue: number;
  transactionId: string;
  output: {
    hash: string;
    index: number;
  };
};

type Utxo = {
  txid: string;
  vout: number;
  value: number;
  status: TransactionStatus;
};

type Vout = {
  scriptpubkey: string;
  scriptpubkey_asm: string;
  scriptpubkey_type: string;
  scriptpubkey_address: string;
  value: number;
};

type Vin = {
  txid: string;
  vout: number;
  prevout: Vout;
  scriptsig: string;
  scriptsig_asm: string;
  is_coinbase: boolean;
  sequence: number;
};

type MempoolTransaction = {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  fee: number;
  status: TransactionStatus;
  vin: Vin[];
  vout: Vout[];
};

type TransactionStatus = {
  confirmed: boolean;
  block_height: number;
  block_hash: string;
  block_time: number;
};

/**
 * Constructs a taproot script for Ordinals transactions.
 *
 * @param publicKey Buffer containing the public key associated with the transaction.
 * @param request InscriptionRequest object containing data to be embedded in the script.
 * @returns Buffer representing the constructed taproot script.
 */
export function buildOrdScript(publicKey: Buffer, request: InscriptionRequest): Buffer {
  // Initial script elements including the public key, standard operations, and 'ord' identifier
  const scriptChunks = [
    publicKey,
    bscript.OPS.OP_CHECKSIG,
    bscript.OPS.OP_FALSE,
    bscript.OPS.OP_IF,
    Buffer.from("ord", "utf8"), // 'ord' identifier as utf8 Buffer
    1,
    1,
    Buffer.from(request.contentType, "utf8"), // Inscription content type
    0,
  ];

  const maxScriptChunkSize = 520; // Maximum size for each data chunk in the script

  // Divide the inscription content into chunks and add them to the script
  for (let i = 0; i < request.content.length; i += maxScriptChunkSize) {
    let end = Math.min(i + maxScriptChunkSize, request.content.length);

    // Add each content chunk to the script
    scriptChunks.push(request.content.subarray(i, end));
  }

  // Finalize the script with OP_ENDIF
  scriptChunks.push(bscript.OPS.OP_ENDIF);

  // Compile the script chunks into a single Buffer and return
  return bscript.compile(scriptChunks);
}

export function buildEmptyRevealTransaction(
  network: bitcoin.networks.Network,
  keypair: ECPairInterface,
  request: InscriptionRequest,
  feeRate: number
): RevealTransaction {
  // Build the inscription script using the internal public key and inscription data
  const payment = buildInscriptionPayment(network, toXOnly(keypair.publicKey), request);

  // Estimate the transaction fee
  const estimatedPsbt = new Psbt({ network });
  estimatedPsbt.addInput({
    hash: Buffer.alloc(32), // Placeholder hash
    index: 0, // Input index
    witnessUtxo: {
      value: MIN_TX_VALUE + 100, // Placeholder value
      script: payment.output!,
    },
  });

  // Update input with taproot script and control block information
  estimatedPsbt.updateInput(0, {
    tapLeafScript: [
      {
        leafVersion: payment.redeem!.redeemVersion!,
        script: payment.redeem!.output!,
        controlBlock: payment.witness![payment.witness!.length - 1],
      },
    ],
  });

  // Add output to the recipient address
  estimatedPsbt.addOutput({
    address: request.recipientAddress,
    value: MIN_TX_VALUE, // Placeholder value
  });

  // Sign and finalize the PSBT
  estimatedPsbt.signInput(0, keypair);
  estimatedPsbt.finalizeAllInputs();

  // Extract the transaction from PSBT
  const transaction = estimatedPsbt.extractTransaction();
  const transactionValue = transaction.virtualSize() * feeRate + MIN_TX_VALUE;

  // Return the details of the reveal transaction
  return {
    inscriptionAddress: payment.address!,
    transactionValue,
    transactionId: "",
    output: {
      hash: "",
      index: 0,
    },
  };
}

export function buildCommitPbst(
  config: InscriptionConfig,
  utxos: Utxo[],
  revealTransactionIns: RevealTransaction[]
): Psbt {
  // create one commit tx
  const network = config.network;
  const psbt = new Psbt({ network });
  let total = 0;
  for (let utxo of utxos) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: bitcoin.address.toOutputScript(config.senderAddress, network),
        value: utxo.value,
      },
    });
    total += utxo.value;
  }

  let spend = 0;
  for (const revealTx of revealTransactionIns) {
    psbt.addOutput({ address: revealTx.inscriptionAddress, value: revealTx.transactionValue });
    spend += revealTx.transactionValue;
  }

  const change = estimateChange(config, utxos.length, revealTransactionIns.length, total, spend);

  if (change > 0) {
    psbt.addOutput({ address: config.changeRecipientAddress, value: change });
  }

  return psbt;
}

const InputSizes: { [key: string]: number } = {
  p2wpkh: 67,
  p2tr: 57,
};

const OutputSizes: { [key: string]: number } = {
  p2wpkh: 31,
  p2tr: 43,
};

export function getAddressType(addr: string): string {
  try {
    const decode = bitcoin.address.fromBech32(addr);

    if (decode.version === 0 && decode.data.length === 20) {
      return "p2wpkh";
    }

    if (decode.version === 1 && decode.data.length === 32) {
      return "p2tr";
    }
    return "unsupport address";
  } catch (e) {
    return "unsupport address";
  }
}

export function estimateChange(
  config: InscriptionConfig,
  numInputs: number,
  numOutputs: number,
  total: number,
  spend: number
): number {
  const senderAddressType = getAddressType(config.senderAddress);
  if (senderAddressType === "unsupport address") {
    throw new Error("unsupport addr type");
  }
  const changeRecipientAdressType = getAddressType(config.changeRecipientAddress);
  if (changeRecipientAdressType === "unsupport address") {
    throw new Error("unsupport addr type");
  }

  const baseSize = 10;

  const inputSize = InputSizes[senderAddressType] * numInputs;
  const outputSize = OutputSizes["p2tr"] * numOutputs;
  const changeOutputSize = OutputSizes[senderAddressType];
  const size = baseSize + inputSize + outputSize;
  const size1 = size + changeOutputSize;

  const left = total - spend;
  const change = left - size1 * config.feeRate;

  if (Math.ceil(left / size) < config.feeRate) {
    throw new Error("insufficient balance");
  }
  return change > MIN_TX_VALUE ? change : 0;
}

export function makeRevealTransactions(
  config: InscriptionConfig,
  keypair: ECPairInterface,
  reveals: RevealTransaction[]
): Transaction[] {
  const publicKey = toXOnly(keypair.publicKey);
  const txs = [];
  for (let i = 0; i < config.inscriptionRequests.length; i++) {
    const request = config.inscriptionRequests[i];
    const inscriptionScript = buildOrdScript(publicKey, request);
    // build p2tr payment
    const scriptTree: Taptree = [
      {
        output: inscriptionScript,
      },
      {
        output: inscriptionScript,
      },
    ];

    const redeem = {
      output: inscriptionScript,
      redeemVersion: LEAF_VERSION_TAPSCRIPT,
    };
    const payment = bitcoin.payments.p2tr({
      internalPubkey: publicKey,
      scriptTree,
      redeem,
      network: config.network,
    });

    const reveal = reveals[i];

    if (reveal.inscriptionAddress !== payment.address) {
      throw new Error("address mismatch");
    }
    const psbt = new Psbt({ network: config.network });
    psbt.addInput({
      hash: reveal.output.hash,
      index: i,
      witnessUtxo: {
        value: reveal.transactionValue,
        script: bitcoin.address.toOutputScript(reveal.inscriptionAddress, config.network),
      },
    });
    psbt.updateInput(0, {
      tapLeafScript: [
        {
          leafVersion: redeem.redeemVersion,
          script: redeem.output,
          controlBlock: payment.witness![payment.witness!.length - 1],
        },
      ],
    });
    psbt.addOutput({
      address: request.recipientAddress,
      value: MIN_TX_VALUE,
    });

    psbt.signInput(0, keypair);
    psbt.finalizeAllInputs();
    txs.push(psbt.extractTransaction());
  }
  return txs;
}

export async function makeCommitTransaction(
  config: InscriptionConfig
): Promise<{ internalKeyWIF: string; tx: string; reveals: RevealTransaction[] }> {
  const client = new MempoolClient(config.network);
  const outputs = await client.getUtxo(config.senderAddress);

  const keypair = ECPair.makeRandom({ network: config.network });
  const reveals: RevealTransaction[] = [];
  for (let request of config.inscriptionRequests) {
    const reveal = buildEmptyRevealTransaction(config.network, keypair, request, config.feeRate);
    reveals.push(reveal);
  }
  const commitPbst = buildCommitPbst(config, outputs, reveals);
  let validated = commitPbst
    .signAllInputs(keypair)
    .validateSignaturesOfAllInputs(validateSchnorrSignature);

  if (!validated) {
    throw new Error("invalid psbt");
  }
  commitPbst.finalizeAllInputs();

  return {
    internalKeyWIF: keypair.toWIF(),
    tx: commitPbst.extractTransaction().toHex(),
    reveals: reveals,
  };
}

function buildInscriptionPayment(
  network: bitcoin.networks.Network,
  publicKey: Buffer,
  request: InscriptionRequest
): Payment {
  const inscriptionScript = buildOrdScript(publicKey, request);
  // build p2tr payment
  const scriptTree: Taptree = [
    {
      output: inscriptionScript,
    },
    {
      output: inscriptionScript,
    },
  ];

  const redeem = {
    output: inscriptionScript,
    redeemVersion: LEAF_VERSION_TAPSCRIPT,
  };
  return bitcoin.payments.p2tr({
    internalPubkey: publicKey,
    scriptTree,
    redeem,
    network,
  });
}

export class MempoolClient {
  url: string;
  constructor(network: bitcoin.networks.Network) {
    if (network === bitcoin.networks.bitcoin) {
      this.url = "https://mempool.space/api/";
      return;
    }
    this.url = "https://mempool.space/testnet/api/";
  }

  async getUtxo(address: string): Promise<Utxo[]> {
    const api = `${this.url}/address/${address}/utxo`;
    return this.callApi<Utxo[]>(api);
  }

  async postTx(txhex: string): Promise<string> {
    const api = `${this.url}/tx`;
    const init: RequestInit = {
      method: "POST",
      body: txhex,
      headers: { "Content-Type": "text/plain" },
    };
    return fetch(api, init).then(async (resp) => {
      if (!resp.ok) {
        console.log(resp.statusText);
        console.log(await resp.text());
        throw new Error("API_STATUS_ERROR");
      }
      return resp.text();
    });
  }

  async getTx(txId: string): Promise<MempoolTransaction> {
    const api = `${this.url}/tx/${txId}`;
    return this.callApi<MempoolTransaction>(api);
  }

  async getTxStatus(txId: string): Promise<TransactionStatus> {
    const api = `${this.url}/tx/${txId}/status`;
    return this.callApi<TransactionStatus>(api);
  }

  async callApi<T>(url: string, init?: RequestInit): Promise<T> {
    return fetch(url, init).then((resp) => {
      if (!resp.ok) {
        throw new Error("API_STATUS_ERROR");
      }
      return resp.json() as unknown as T;
    });
  }
}

export class OrdTool {
  internalKeypair: ECPairInterface;
  config: InscriptionConfig;
  client: MempoolClient;
  commitTransactionId: string = "";

  constructor(config: InscriptionConfig) {
    this.config = config;
    this.internalKeypair = ECPair.makeRandom({ network: config.network });
    this.client = new MempoolClient(config.network);
  }

  async makeUnsignedCommitPsbt(): Promise<Psbt> {
    const network = this.config.network;
    const revealTransactions = this.config.inscriptionRequests.map((request) =>
      buildEmptyRevealTransaction(network, this.internalKeypair, request, this.config.feeRate)
    );

    const client = new MempoolClient(network);
    const outputs = await client.getUtxo(this.config.senderAddress);
    console.log("send address:", this.config.senderAddress);
    console.log(`used ${outputs.length} utxos`);

    return buildCommitPbst(this.config, outputs, revealTransactions);
  }

  async postCommitTransaction(commitPsbt: Psbt): Promise<string> {
    const addressType = getAddressType(this.config.senderAddress);

    if (addressType === "unsupport address type") {
      throw new Error("unsupport sender address type");
    }
    const validator = addressType === "p2tr" ? validateSchnorrSignature : validateEcdsaSignature;

    const validated = commitPsbt.validateSignaturesOfAllInputs(validator);

    if (!validated) {
      throw new Error("commit psbt not signed");
    }
    commitPsbt = commitPsbt.finalizeAllInputs();
    this.commitTransactionId = await this.client.postTx(commitPsbt.extractTransaction().toHex());
    return this.commitTransactionId;
  }

  async postRevealTransactions() {
    if (this.commitTransactionId.length == 0) {
      throw new Error("commit transaction not post");
    }

    const tx = await this.client.getTx(this.commitTransactionId);

    if (!tx.status.confirmed) {
      throw new Error("commit transaction not confirmed");
    }

    const publicKey = toXOnly(this.internalKeypair.publicKey);
    const vouts = tx.vout;
    for (let i = 0; i < this.config.inscriptionRequests.length; i++) {
      const request = this.config.inscriptionRequests[i];
      const inscriptionScript = buildOrdScript(publicKey, request);
      // build p2tr payment
      const scriptTree: Taptree = [
        {
          output: inscriptionScript,
        },
        {
          output: inscriptionScript,
        },
      ];

      const redeem = {
        output: inscriptionScript,
        redeemVersion: LEAF_VERSION_TAPSCRIPT,
      };
      const payment = bitcoin.payments.p2tr({
        internalPubkey: publicKey,
        scriptTree,
        redeem,
        network: this.config.network,
      });

      const psbt = new Psbt({ network: this.config.network });
      psbt.addInput({
        hash: this.commitTransactionId,
        index: i,
        witnessUtxo: {
          value: vouts[i].value,
          script: bitcoin.address.toOutputScript(payment.address!, this.config.network),
        },
      });
      psbt.updateInput(0, {
        tapLeafScript: [
          {
            leafVersion: redeem.redeemVersion,
            script: redeem.output,
            controlBlock: payment.witness![payment.witness!.length - 1],
          },
        ],
      });
      psbt.addOutput({
        address: request.recipientAddress,
        value: MIN_TX_VALUE,
      });

      psbt.signInput(0, this.internalKeypair);

      const validated = psbt.validateSignaturesOfAllInputs(validateSchnorrSignature);

      if (!validated) {
        throw new Error("reveal psbt not signed");
      }

      psbt.finalizeAllInputs();

      const txId = await this.client.postTx(psbt.extractTransaction().toHex());
      console.log("reveal transaction id:", txId);
    }
  }

  async waitUntilTransactionConfirm(txId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = async () => {
        try {
          const status = await this.client.getTxStatus(txId);
          console.log("transaction ", txId, "confirmed", status.confirmed);
          if (status.confirmed) {
            return resolve();
          }
        } catch (e) {
          console.error("getTx error", e);
        }
        setTimeout(check, 60_000);
      };
      check();
    });
  }
}
