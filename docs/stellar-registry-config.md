# Stellar Registry Configuration

`REGISTRY_CONTRACT_ID`, `STELLAR_NETWORK`, and `SOROBAN_RPC_URL` are one
configuration tuple. The indexer, BFF registry reads, and
`@flovia/x402-stellar` on-chain payment logger all validate and use this tuple.

| Mode | `STELLAR_NETWORK` | `SOROBAN_RPC_URL` | `REGISTRY_CONTRACT_ID` | Behavior |
| --- | --- | --- | --- | --- |
| Local mock | unset | unset | unset | Use fixture/read-model data. Do not start the chain indexer or call `log_payment`. |
| Testnet | `testnet` | `https://soroban-testnet.stellar.org` (or a matching Testnet RPC) | deployed `C...` ID | Live registry reads, event indexing, and payment logging. |

Copy the root `.env.example`, set the deployed contract ID, and run the
continuous Testnet indexer from the repository root:

```sh
bun run indexer:testnet
```

The process exits if the contract ID is missing/invalid or if the RPC hostname
clearly belongs to a different Stellar network. Registry events from any other
contract are rejected rather than skipped.