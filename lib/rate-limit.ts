/**
 * Minimal in-memory rate limiter for API routes.
 *
 * Note: on serverless platforms each instance keeps its own buckets, so this
 * throttles rather than hard-caps. Durable abuse control belongs in an edge
 * WAF; this closes casual spam of the write endpoints for the demo deployment.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimitOk(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

export function clientKey(request: Request, scope: string) {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : "local";
  return `${scope}:${ip}`;
}
