import type { Context as ApiContext } from "@clipradar/api/context";
import { auth, db } from "./services";

export async function createContext({
  req,
}: {
  req: Request;
}): Promise<ApiContext> {
  const session = await auth.api.getSession({
    headers: req.headers,
  });
  return {
    db,
    session,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
