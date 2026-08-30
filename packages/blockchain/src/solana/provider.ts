import { Connection, PublicKey } from "@solana/web3.js";
import type { AppConfig } from "@aegix/config";
import type {
  BlockchainProvider,
  GetSignaturesOptions,
  RawTransaction,
  SignatureInfo,
  TokenAccountInfo
} from "../types.js";
import { formatSignatureInfo, formatTokenAccount, isValidSolanaAddress } from "./address.js";

const DEFAULT_COMMITMENT = "confirmed";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** Solana RPC provider implementing BlockchainProvider, see architecture.md §39-§41. */
export class SolanaRpcProvider implements BlockchainProvider {
  readonly chain = "solana" as const;
  readonly name: string;

  private readonly connection: Connection;

  constructor(
    config: Pick<AppConfig, "RPC_URL" | "RPC_WEBSOCKET_URL">,
    options: { name?: string } = {}
  ) {
    this.name = options.name ?? new URL(config.RPC_URL).hostname;
    this.connection = new Connection(config.RPC_URL, {
      commitment: DEFAULT_COMMITMENT,
      wsEndpoint: config.RPC_WEBSOCKET_URL,
      confirmTransactionInitialTimeout: 30_000
    });
  }

  validateAddress(address: string): boolean {
    return isValidSolanaAddress(address);
  }

  async getSignatures(address: string, options: GetSignaturesOptions = {}): Promise<SignatureInfo[]> {
    const result = await this.connection.getSignaturesForAddress(
      this.pubkey(address),
      {
        limit: options.limit ?? 100,
        before: options.before,
        until: options.until
      },
      DEFAULT_COMMITMENT
    );
    return result.map((sig) =>
      formatSignatureInfo({ signature: sig.signature, slot: sig.slot, blockTime: sig.blockTime })
    );
  }

  async getTransaction(signature: string): Promise<RawTransaction | null> {
    const tx = await this.connection.getParsedTransaction(signature, {
      commitment: DEFAULT_COMMITMENT,
      maxSupportedTransactionVersion: 0
    });
    if (!tx) return null;
    return {
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime ?? null,
      json: tx
    };
  }

  async getTokenAccounts(address: string): Promise<TokenAccountInfo[]> {
    const result = await this.connection.getParsedTokenAccountsByOwner(
      this.pubkey(address),
      { programId: TOKEN_PROGRAM_ID },
      DEFAULT_COMMITMENT
    );
    return result.value
      .map((v) => formatTokenAccount({ account: v.account }))
      .filter((v): v is TokenAccountInfo => v !== null);
  }

  async getBalance(address: string): Promise<number> {
    return this.connection.getBalance(this.pubkey(address), DEFAULT_COMMITMENT);
  }

  async getLatestBlockHeight(): Promise<number> {
    return this.connection.getBlockHeight(DEFAULT_COMMITMENT);
  }

  private pubkey(address: string): PublicKey {
    return new PublicKey(address);
  }
}
