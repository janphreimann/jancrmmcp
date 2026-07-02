import type { Request, Response, NextFunction } from "express";

const API_KEY = process.env.MCP_API_KEY;

if (!API_KEY) throw new Error("MCP_API_KEY must be set");

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const header = req.headers["authorization"] ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : String(header);
  if (token !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}
