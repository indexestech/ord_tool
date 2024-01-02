# Bitcoin Ordinals Inscription Tool

This tool is designed to facilitate the creation and management of Ordinals inscriptions on the Bitcoin blockchain using taproot (P2TR) transactions. It leverages the bitcoinjs-lib library to build and sign transactions, specifically focusing on batch minting Ordinals inscriptions.

## Features

- Create taproot scripts for Ordinals inscriptions.
- Create one Commit Transaction and multiple Reveal Transactions

## Installation

Before you begin, ensure that you have bun.js installed on your system. Then, install the necessary dependencies by running:

```bash
bun install
```

This will install bitcoinjs-lib, tiny-secp256k1, and other required libraries.

## Usage

### Workflow

- **Create a Commit Transaction**: Generate a transaction that commits to the inscription.
- **Sign the Commit Transaction**: Use your wallet or code to sign the transaction.
- **Post the Commit Transaction**: Broadcast the signed transaction to the blockchain via the Mempool API.
- **Post Reveal Transactions**: After the commit transaction, broadcast reveal transactions to the blockchain.

### Example

For detailed usage, please refer to **example.ts** in the project. Here's a brief overview:

```javascript
// Configure the network and inscription details
const network = testnet;
const config: InscriptionConfig = {
  // Your configuration details here...
};

const tool = new OrdTool(config);

// Generate and sign the commit transaction
let unsignCommitPsbt = await tool.makeUnsignedCommitPsbt();
// Sign the transaction using your private key or wallet (ensure security practices)
// ...

// Broadcast the commit transaction and wait for confirmation
const commitTransactionId = await tool.postCommitTransaction(signedCommitPsbt);
console.log("Commit transaction ID:", commitTransactionId);
await tool.waitUntilTransactionConfirm(commitTransactionId);

// Broadcast the reveal transactions
await tool.postRevealTransactions();
```

## Security and Best Practices

- **Secure Handling of Private Keys**: Avoid exposing private keys in your code. Use secure methods like hardware wallets or trusted signing services for transaction signing.
- **Test on Testnet**: Always test your transactions on the testnet before executing on the mainnet.
- **Verify and Confirm**: Ensure to verify transaction details and wait for confirmation before proceeding with subsequent steps.

## Contributions

Contributions to enhance the tool or extend its capabilities are welcome. Please adhere to standard coding practices and provide documentation for your contributions.

Follow on [Twitter](https://twitter.com/BitcoinIndexer)
