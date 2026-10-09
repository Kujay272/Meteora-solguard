// ═══════════════════════════════════════════════════════════════
//  SOLGUARD — environment + secret hygiene
// ═══════════════════════════════════════════════════════════════
//
//  Reads the project's own .env.Solana so an RPC key never has to be
//  exported into a shell, typed onto a command line, or pasted into
//  source.
//
//  Every endpoint that gets PRINTED goes through redact() first. A key
//  that lands in a screenshot or a screen-share is a leaked key, and
//  the UI prints its endpoint on every page load.
//
//  This module reads configuration only. It never writes to disk.

import fs from 'fs';
import path from 'path';

/** Parse KEY=VALUE lines from one file into process.env (never overwriting). */
export function loadEnvFile(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k && !process.env[k]) process.env[k] = v;
    }
    return true;
  } catch {
    return false; // a missing or unreadable .env is not fatal
  }
}

/**
 * Load the nearest project .env.Solana. Returns the path it used, or null.
 * Real environment variables always win over the file.
 */
export function loadProjectEnv(): string | null {
  const candidates = [
    path.join(__dirname, '..', '.env.Solana'),
    path.join(process.cwd(), '.env.Solana'),
    path.join(__dirname, '..', '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const f of candidates) if (loadEnvFile(f)) return f;
  return null;
}

/** Strip api keys so an endpoint is safe to print, screenshot or share. */
export function redact(url: string): string {
  return String(url)
    .replace(/([?&](?:api[-_]?key|apikey|key|token)=)[^&]*/gi, '$1***')
    .replace(/\/(v2|v3)\/[A-Za-z0-9_-]{16,}/g, '/$1/***');
}
