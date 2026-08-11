import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOADER = path.join(PROJECT_ROOT, 'src', 'config', 'loadEnv.js');

/**
 * Regression guard for the original bug: `import 'dotenv/config'` resolves `.env`
 * against process.cwd(), so launching the bot from any other directory silently
 * dropped every variable — including AI_API_KEY — making a correctly configured
 * bot insist it had no key.
 */
function readKeyFromCwd(cwd, extraEnv = {}) {
    const script = `import(${JSON.stringify(LOADER)}).then(() => {
        process.stdout.write(JSON.stringify({ key: process.env.AI_API_KEY || null }));
    });`;

    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd,
        env: { ...process.env, AI_API_KEY: '', ...extraEnv },
        encoding: 'utf8',
    });

    return JSON.parse(output);
}

test('loads the project .env even when started from another working directory', (t) => {
    const envPath = path.join(PROJECT_ROOT, '.env');
    if (fs.existsSync(envPath)) {
        t.skip('a real .env exists in the project root — not overwriting it');
        return;
    }

    fs.writeFileSync(envPath, 'AI_API_KEY=sk-from-project-root\n');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'slitz-cwd-'));

    try {
        assert.equal(readKeyFromCwd(elsewhere).key, 'sk-from-project-root');
        assert.equal(readKeyFromCwd(PROJECT_ROOT).key, 'sk-from-project-root');
    } finally {
        fs.rmSync(envPath, { force: true });
        fs.rmSync(elsewhere, { recursive: true, force: true });
    }
});

test('real environment variables always win over the .env file', (t) => {
    const envPath = path.join(PROJECT_ROOT, '.env');
    if (fs.existsSync(envPath)) {
        t.skip('a real .env exists in the project root — not overwriting it');
        return;
    }

    fs.writeFileSync(envPath, 'AI_API_KEY=sk-from-file\n');

    try {
        // Simulates Railway/Docker/systemd injecting the key directly.
        const result = readKeyFromCwd(PROJECT_ROOT, { AI_API_KEY: 'sk-from-host' });
        assert.equal(result.key, 'sk-from-host');
    } finally {
        fs.rmSync(envPath, { force: true });
    }
});

test('missing .env files are not fatal', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'slitz-noenv-'));
    try {
        assert.doesNotThrow(() => readKeyFromCwd(elsewhere));
    } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
    }
});

test('a blank host variable does not shadow the real value in .env', (t) => {
    const envPath = path.join(PROJECT_ROOT, '.env');
    if (fs.existsSync(envPath)) {
        t.skip('a real .env exists in the project root — not overwriting it');
        return;
    }

    fs.writeFileSync(envPath, 'AI_API_KEY=sk-real-key\n');

    try {
        // Hosting panels frequently create the variable with an empty value.
        const result = readKeyFromCwd(PROJECT_ROOT, { AI_API_KEY: '   ' });
        assert.equal(result.key, 'sk-real-key');
    } finally {
        fs.rmSync(envPath, { force: true });
    }
});
