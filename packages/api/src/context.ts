import type { Session } from "@clipradar/auth";
import type { Database } from "@clipradar/db";

export interface Context {
  db: Database;
  session: Session | null;
}
