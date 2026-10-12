export const PING_TOKEN_PATTERN = /^rmp1_[A-Za-z0-9_-]{43}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPingToken(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of random) binary += String.fromCharCode(byte);
  return `rmp1_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sanitizeErrorSummary(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  return value
    .replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "authorization=[REDACTED]")
    .replace(/[A-Z0-9_.-]*(?:password|passwd|token|secret|api[_-]?key|access[_-]?key)[A-Z0-9_.-]*\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/(--(?:password|password-file|repository|repo))\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/rmp1_[A-Za-z0-9_-]{43}/g, "[TOKEN]")
    .replace(/\b(?:https?|s3|gs|azure|b2|rest|sftp):\/\/[^\s]+/gi, "[URL]")
    .replace(/\b[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s]*/g, "[PATH]")
    .replace(/(^|[\s=(])\/(?:[^\s/]+\/)*[^\s,;)]*/g, "$1[PATH]")
    .slice(0, 1024);
}

export function normalizeSlug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}
