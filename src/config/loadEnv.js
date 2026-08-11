// loadEnv.js — deterministic .env loading.
//
// `import 'dotenv/config'` resolves `.env` relative to process.cwd(), so the bot
// silently starts with ZERO env vars whenever it is launched from another folder
// (systemd units, pm2, `node /opt/bot/src/app.js`, Docker with a different
// WORKDIR, ...). That looked exactly like "my AI_API_KEY is missing" even though
// the key was sitting in .env the whole time.
//
// This module always loads the .env that lives next to package.json, then falls
// back to the current working directory. Real environment variables (Railway,
// Docker `-e`, systemd `Environment=`) always win — dotenv never overrides them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '..', '..');

const loadedFiles = [];

function loadIfPresent(filePath) {
    if (!filePath || loadedFiles.includes(filePath) || !fs.existsSync(filePath)) {
        return;
    }
    // `quiet: true` suppresses dotenv v17's promotional banner, which otherwise
    // pollutes stdout (and breaks anything parsing the bot's output).
    const result = dotenv.config({ path: filePath, quiet: true });
    if (result.error) {
        return;
    }
    loadedFiles.push(filePath);

    // dotenv never overwrites a variable that already exists — but hosting panels
    // (Railway, Pterodactyl, Docker Compose) very often define a variable with an
    // EMPTY value. That blank shadowed the real value in .env, which is one way a
    // configured AI_API_KEY ended up looking "missing". A blank is not a choice,
    // so let the file fill it in.
    for (const [key, value] of Object.entries(result.parsed || {})) {
        if (String(process.env[key] ?? '').trim() === '' && String(value).trim() !== '') {
            process.env[key] = value;
        }
    }
}

// Project root first (authoritative), then cwd for people who keep a local override.
loadIfPresent(path.join(PROJECT_ROOT, '.env'));
loadIfPresent(path.join(process.cwd(), '.env'));

export const envFilesLoaded = loadedFiles;
export const projectRoot = PROJECT_ROOT;

export default { envFilesLoaded: loadedFiles, projectRoot: PROJECT_ROOT };
