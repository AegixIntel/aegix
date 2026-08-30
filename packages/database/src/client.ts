import postgres from "postgres";

export type Sql = postgres.Sql;

/** Serializable JSON payload accepted by sql.json(...). */
export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export function createDb(databaseUrl: string): postgres.Sql {
  return postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10
  });
}
