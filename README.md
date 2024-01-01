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

1. Create a Commit Transaction
2. Sign this Commit Transaction through your wallet or code
3. Post this Commit Transaction to blockchain through mempool api
4. Post Reveal Transactions to blockchain through mempool api

Example

```javascript

```
