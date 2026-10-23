import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

// ─── Versiegelung ────────────────────────────────────────────────────────────
//
// Der Server hält keinen Zustand (Vercel, stateless) — alles, was er über eine
// Sitzung weiß, steckt im Token selbst bzw. (API-Keys) in einem Blob, den nur
// er öffnen kann. Weil darin die Supabase-Sitzung des Nutzers liegt (Access-
// und Refresh-Token), werden die Nutzlasten *verschlüsselt* und nicht nur
// signiert: wer ein MCP-Token oder die Datenbankzeile eines API-Keys in die
// Hand bekommt, soll daraus keine CRM-Sitzung herauslösen können.
// AES-256-GCM ist zugleich authentifiziert, ersetzt die Signatur also mit.

export function keyMaterial(): Buffer {
  if (!process.env.MCP_API_KEY) throw new Error("MCP_API_KEY must be set");
  return createHash("sha256").update(process.env.MCP_API_KEY).digest();
}

export function seal(payload: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function open<T>(token: string): T | null {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyMaterial(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
