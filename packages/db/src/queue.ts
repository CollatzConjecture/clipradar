/**
 * The lease rules both leased queues share, so jobs and versions cannot
 * drift apart on lease length, heartbeat, give-up, or attempt cap. Private
 * to this package: package.json does not export it.
 *
 * The fence: a worker write commits only while its row still matches the
 * claimed id and attempt, the running status, and lease_expires_at > now().
 * A worker whose lease lapsed writes nothing, even before anyone reclaims it.
 */
import { sql } from "drizzle-orm";

import type { Database } from "./index";

const LEASE_SECONDS = 60;
const HEARTBEAT_MS = 15_000;
const HEARTBEAT_GIVE_UP_MS = 45_000;
const MAX_ERROR_CHARS = 1000;

export const MAX_ATTEMPTS = 3;
export const NOT_HELD = "another attempt holds it, or it expired";

export const leaseEnd = sql`now() + make_interval(secs => ${LEASE_SECONDS})`;

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface Heartbeat {
  /** Stops beating, aborts `signal`, and returns its reason for `throw`. */
  lose: (why: string) => unknown;
  /** Aborts when the lease is lost or the worker shuts down. */
  readonly signal: AbortSignal;
  /** Stops beating without aborting. */
  stop: () => void;
}

/**
 * Extends the lease every 15 s with `extend`, which resolves true when this
 * attempt still owned the row. A false beat, or 45 s without a beat reaching
 * Postgres, loses the lease.
 */
export function startHeartbeat(
  label: string,
  extend: () => Promise<boolean>,
  shutdown: AbortSignal
): Heartbeat {
  const lost = new AbortController();
  const signal = AbortSignal.any([lost.signal, shutdown]);
  let stopped = false;
  let beating = false;
  let lastBeat = performance.now();

  const stop = () => {
    stopped = true;
    clearInterval(heartbeat);
  };
  const lose = (why: string): unknown => {
    stop();
    lost.abort(new Error(`Lost the lease on ${label}: ${why}.`));
    return signal.reason;
  };

  const beat = async () => {
    const extended = await extend();
    if (stopped) {
      return;
    }
    if (!extended) {
      lose(NOT_HELD);
      return;
    }
    lastBeat = performance.now();
  };
  const heartbeat = setInterval(() => {
    if (performance.now() - lastBeat > HEARTBEAT_GIVE_UP_MS) {
      lose(
        `no heartbeat reached Postgres for ${HEARTBEAT_GIVE_UP_MS / 1000} s`
      );
      return;
    }
    if (beating) {
      return;
    }
    beating = true;
    beat()
      .catch(() => undefined)
      .finally(() => {
        beating = false;
      });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return { signal, lose, stop };
}

export function truncate(error: string): string {
  return error.length > MAX_ERROR_CHARS
    ? `${error.slice(0, MAX_ERROR_CHARS - 1)}…`
    : error;
}
