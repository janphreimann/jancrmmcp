// Issuer URL muss beim Start feststehen (nicht pro Anfrage), weil
// express-rate-limit in mcpAuthRouter einmalig angelegt wird, nicht pro
// Anfrage (Vercel-Serverless-Zwang) — siehe index.ts. Eigenes Modul, damit
// oauth.ts (Magic-Link-Redirects) dieselbe URL sieht wie index.ts.
export const ISSUER_URL = new URL(
  process.env.SERVER_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `http://localhost:${process.env.PORT ?? 3000}`)
);
