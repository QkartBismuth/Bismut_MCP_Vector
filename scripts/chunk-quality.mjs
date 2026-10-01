import { chunkDocument } from "../dist/chunking/index.js";
import { languageForFile } from "../dist/chunking/languages.js";

const cases = [
  { name: "python", uri: "src/auth/jwt_tokens.py", text: `"""JWT token utilities.

Provides helpers for signing and verifying JSON Web Tokens.
"""
import os
import time
import hmac
import hashlib
from typing import Optional

DEFAULT_TTL = 3600
ALGORITHM = "HS256"


class TokenSigner:
    """Signs and verifies tokens using a shared secret."""

    def __init__(self, secret: bytes, ttl: int = DEFAULT_TTL) -> None:
        self.secret = secret
        self.ttl = ttl

    def sign(self, payload: dict) -> str:
        """Create a signed token from a payload."""
        payload = dict(payload)
        payload["exp"] = int(time.time()) + self.ttl
        raw = repr(sorted(payload.items())).encode("utf-8")
        signature = hmac.new(self.secret, raw, hashlib.sha256).hexdigest()
        return f"{signature}:{raw.hex()}"

    def verify(self, token: str) -> Optional[dict]:
        """Parse and validate a token, returning the payload or None."""
        try:
            signature, body = token.split(":", 1)
        except ValueError:
            return None
        raw = bytes.fromhex(body)
        expected = hmac.new(self.secret, raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        if raw and payload_expired(raw):
            return None
        return dict(sorted(eval(bytes.fromhex(body)).items()))


def payload_expired(raw: bytes) -> bool:
    return False


def rotate_secret(new_secret: bytes) -> TokenSigner:
    """Create a signer with a rotated secret."""
    return TokenSigner(new_secret)
` },
  { name: "typescript", uri: "src/server/routes.ts", text: `import express from "express";
import { z } from "zod";
import { authMiddleware } from "./middleware";

export const app = express();

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

export async function createUser(req: express.Request, res: express.Response) {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const user = await db.user.create({ data: parsed.data });
  return res.status(201).json(user);
}

export async function deleteUser(req: express.Request, res: express.Response) {
  const id = req.params.id;
  await db.user.delete({ where: { id } });
  return res.status(204).end();
}

class RateLimiter {
  private buckets = new Map<string, number[]>();

  check(key: string): boolean {
    const now = Date.now();
    const hits = (this.buckets.get(key) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= 100) return false;
    hits.push(now);
    this.buckets.set(key, hits);
    return true;
  }
}
` },
  { name: "rust", uri: "src/store/mod.rs", text: `use std::collections::HashMap;
use std::sync::RwLock;

pub struct Store {
    entries: RwLock<HashMap<String, Vec<u8>>>,
}

impl Store {
    pub fn new() -> Self {
        Store { entries: RwLock::new(HashMap::new()) }
    }

    pub fn insert(&self, key: &str, value: Vec<u8>) {
        let mut guard = self.entries.write().unwrap();
        guard.insert(key.to_string(), value);
    }

    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let guard = self.entries.read().unwrap();
        guard.get(key).cloned()
    }
}

pub fn evict_oldest(store: &Store, count: usize) {
    let guard = store.entries.read().unwrap();
    let mut keys: Vec<&String> = guard.keys().collect();
    keys.sort();
    for key in keys.into_iter().take(count) {
        drop(guard);
        store.remove(key);
        return;
    }
}
` },
  { name: "markdown", uri: "docs/architecture.md", text: `# Architecture

Bismut is a local vector database exposed over MCP.

## Storage

We store vectors in SQLite via the sqlite-vec extension. Each collection
gets its own virtual table. Chunk text and metadata live in ordinary tables.

## Embeddings

Embeddings are computed locally with a quantized ONNX sentence transformer.
No network calls are made. Vectors are L2-normalized, so cosine distance is
used directly as the ranking metric.

### Choosing a model

Multilingual models are recommended when the corpus mixes languages.
` },
];

for (const c of cases) {
  const lang = languageForFile(c.uri);
  const chunks = chunkDocument(c.text, { uri: c.uri, title: null });
  console.log(`\n${"=".repeat(70)}`);
  console.log(`${c.name.padEnd(12)} ${c.uri}   lang=${lang.name} style=${lang.style}  -> ${chunks.length} chunks`);
  console.log("=".repeat(70));
  for (const ch of chunks) {
    const lines = `${ch.startLine}-${ch.endLine}`;
    const body = ch.text.split("\n");
    const first = body.find((l) => !l.startsWith("file:")) ?? body[0];
    console.log(`  [L${lines}] tokens=${String(ch.tokens).padStart(3)}  ${first?.slice(0, 62)}`);
  }
  const bad = chunks.filter((ch) => ch.text.trim().length < 24);
  if (bad.length > 0) console.log(`  !! ${bad.length} suspiciously small chunks`);
  const noLines = chunks.filter((ch) => ch.startLine === null);
  if (noLines.length > 0) console.log(`  !! ${noLines.length} chunks missing line numbers`);
  if (!chunks.every((ch) => ch.embedText.includes("file: "))) {
    console.log("  !! some chunks are missing the file header in embedText");
  }
}