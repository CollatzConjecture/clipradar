import { createAuth } from "@clipradar/auth";
import { createDb } from "@clipradar/db";

import { ENV } from "./env.server";

export const db = createDb(ENV);
export const auth = createAuth(ENV, db);
