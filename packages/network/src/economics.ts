import type postgres from "postgres";

export const AEX_PURPOSES = ["STAKE", "UNSTAKE", "VERIFICATION_REWARD", "RESEARCH_BOUNTY", "ECOSYSTEM_INCENTIVE"] as const;
export interface AexTransfer {
  eventKey: string;
  debitAccount: string;
  creditAccount: string;
  amount: string;
  purpose: typeof AEX_PURPOSES[number];
  evidenceRef: string;
}
export function validateTransfer(input: AexTransfer): bigint {
  for (const value of [input.eventKey, input.debitAccount, input.creditAccount, input.evidenceRef]) {
    if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error("Invalid ledger reference");
  }
  if (input.debitAccount === input.creditAccount) throw new Error("Self transfer is not allowed");
  if (!AEX_PURPOSES.includes(input.purpose)) throw new Error("Invalid economic purpose");
  if (!/^[1-9][0-9]{0,77}$/.test(input.amount)) throw new Error("Amount must be positive integer atomic units");
  return BigInt(input.amount);
}

/** Internal, pre-funded accounting. No mint, deposit claim, withdrawal or signing. */
export function createAexLedger(sql: postgres.Sql) {
  return {
    async transfer(input: AexTransfer): Promise<{ replayed: boolean }> {
      const amount = validateTransfer(input);
      return sql.begin(async tx => {
        // Same event serializes before account locks; conflicting payloads cannot replay.
        await tx`select pg_advisory_xact_lock(hashtextextended(${`aex:${input.eventKey}`}, 0))`;
        const [existing] = await tx`select * from aex_transfers where event_key = ${input.eventKey}`;
        if (existing) {
          if (existing.debit_account !== input.debitAccount || existing.credit_account !== input.creditAccount ||
              existing.amount !== input.amount || existing.purpose !== input.purpose || existing.evidence_ref !== input.evidenceRef) {
            throw new Error("Idempotency key reused with different transfer");
          }
          return { replayed: true };
        }
        // Stable order prevents opposing transfers from deadlocking.
        const accounts = await tx`select id, balance from aex_accounts
          where id in (${input.debitAccount}, ${input.creditAccount}) order by id for update`;
        const debit = accounts.find(row => row.id === input.debitAccount);
        const credit = accounts.find(row => row.id === input.creditAccount);
        if (!debit || !credit) throw new Error("Ledger accounts must be provisioned first");
        if (BigInt(debit.balance) < amount) throw new Error("Insufficient AEX balance");
        if (BigInt(credit.balance) + amount >= 10n ** 78n) throw new Error("AEX balance overflow");
        await tx`update aex_accounts set balance = balance - ${input.amount}::numeric where id = ${input.debitAccount}`;
        await tx`update aex_accounts set balance = balance + ${input.amount}::numeric where id = ${input.creditAccount}`;
        await tx`insert into aex_transfers (event_key, debit_account, credit_account, amount, purpose, evidence_ref)
          values (${input.eventKey}, ${input.debitAccount}, ${input.creditAccount}, ${input.amount}, ${input.purpose}, ${input.evidenceRef})`;
        return { replayed: false };
      }) as Promise<{ replayed: boolean }>;
    }
  };
}
