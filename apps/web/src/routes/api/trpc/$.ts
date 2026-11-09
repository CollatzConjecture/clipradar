import { appRouter } from "@clipradar/api/routers/index";
import { LIMITS } from "@clipradar/db/editor";
import { createFileRoute } from "@tanstack/react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { createContext } from "../../../context";

const PAYLOAD_TOO_LARGE = 413;
const LENGTH_REQUIRED = 411;

/**
 * tRPC's fetch adapter reads any body size, so a mutation must declare a
 * length within the editor's document cap. Browsers always send one for a
 * JSON body.
 */
function oversized(request: Request): Response | null {
  if (request.method !== "POST") {
    return null;
  }
  const length = request.headers.get("content-length");
  if (length === null) {
    return new Response(null, { status: LENGTH_REQUIRED });
  }
  return Number(length) <= LIMITS.requestBytes
    ? null
    : new Response(null, { status: PAYLOAD_TOO_LARGE });
}

function handler({ request }: { request: Request }) {
  const refused = oversized(request);
  if (refused) {
    return refused;
  }
  return fetchRequestHandler({
    req: request,
    router: appRouter,
    createContext,
    endpoint: "/api/trpc",
  });
}

export const Route = createFileRoute("/api/trpc/$")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
    },
  },
});
