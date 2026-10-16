#!/usr/bin/env node
/**
 * haggl.ai agentic discounts: a PreToolUse hook for the checkout tools of Shopify's Shop skill (create_checkout and
 * update_checkout on mcp.shop.com).
 *
 * It reads the hook input on stdin and takes the store's domain from the tool input's `shop` field, which Shop's
 * schema defines as the "Exact seller.domain storefront hostname from offer; no scheme/path". It sends that domain,
 * and nothing else from the checkout, to haggl.ai's public merchant search (GET /api/discounts?q=<domain>), with a
 * 2-second timeout, at most once per store per session. When a merchant on that host runs a sales agent with a max
 * discount above zero, it prints factual additionalContext for the agent.
 *
 * It never denies, asks or approves (no permissionDecision) and never rewrites Shop's input (no updatedInput), so the
 * checkout runs exactly as the agent sent it. Any error, timeout or non-match ends with exit code 0 and no output.
 *
 * Environment:
 *   HAGGL_HOOK_DISABLED=1    turns the hook off.
 *   HAGGL_HOOK_ORIGIN        replaces https://www.haggl.ai, for tests and local development (https, or http on a
 *                            loopback host).
 *   HAGGL_HOOK_STATE_DIR     where it records, per session, the hashed store domains it already looked up
 *                            (default: <os tmpdir>/haggl-agentic-discounts).
 *
 * Node 18 or later, no dependencies.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ORIGIN = 'https://www.haggl.ai';
export const LOOKUP_TIMEOUT_MS = 2_000;
/** The whole run, stdin included, ends by then. hooks.json gives the hook more time than this. */
export const HARD_EXIT_MS = 3_000;
export const USER_AGENT = 'haggl-agentic-discounts-hook (+https://www.haggl.ai/agentic-discounts)';

const MAX_STDIN_BYTES = 1_000_000;
const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_STORES_PER_SESSION = 200;
/** hooks.json matches Shop's checkout tools by name; this repeats the check for hosts that ignore matchers. */
const CHECKOUT_TOOL = /(^|__)(create|update)_checkout$/;
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const VENDOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** @typedef {Record<string, string | undefined>} Env */

/** A website, URL or bare domain as a lowercase hostname without "www.", or null when it isn't one. */
export function hostOf(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw || raw.length > 2048) return null;
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
        const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
        return HOSTNAME.test(host) ? host : null;
    } catch {
        return null;
    }
}

/** The store's domain in a Shop create_checkout or update_checkout call, or null. */
export function storeDomain(hookInput) {
    if (!hookInput || typeof hookInput !== 'object') return null;
    if (typeof hookInput.tool_name === 'string' && !CHECKOUT_TOOL.test(hookInput.tool_name)) return null;
    let toolInput = hookInput.tool_input;
    if (typeof toolInput === 'string') {
        try {
            toolInput = JSON.parse(toolInput);
        } catch {
            return null;
        }
    }
    if (!toolInput || typeof toolInput !== 'object') return null;
    return hostOf(toolInput.shop);
}

/** The same store: one host, or one a subdomain of the other (shop.degrenne.fr and degrenne.fr), as haggl.ai's search matches. */
export function sameStore(a, b) {
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** The first merchant on the store's host whose max discount is above zero, or null. */
export function matchingMerchant(searchResponse, domain) {
    const merchants = searchResponse && Array.isArray(searchResponse.merchants) ? searchResponse.merchants : [];
    for (const merchant of merchants) {
        if (!merchant || typeof merchant !== 'object') continue;
        const host = hostOf(merchant.website);
        const pct = merchant.max_discount_pct;
        if (host && sameStore(host, domain) && typeof pct === 'number' && Number.isFinite(pct) && pct > 0) return merchant;
    }
    return null;
}

/** Merchant text is data: one line, no control or direction characters, at most `max` characters. */
export function plainText(value, max = 80) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** 12 is "12%", 10.84 is "10.8%". */
export function formatPct(pct) {
    return `${Math.round(Math.min(pct, 100) * 10) / 10}%`;
}

/** What the agent reads next to Shop's result: who the merchant is, its max discount, and what the user can choose. */
export function contextFor(merchant, domain, origin = DEFAULT_ORIGIN) {
    const name = plainText(merchant.name) || domain;
    const who = merchant.demo === true ? `${name} (one of haggl.ai's demo merchants)` : name;
    const vendorId = typeof merchant.vendorId === 'string' && VENDOR_ID.test(merchant.vendorId) ? merchant.vendorId : null;
    const where = vendorId ? ` (vendor_id "${vendorId}", ${origin}/agentic-discounts/${encodeURIComponent(vendorId)})` : '';
    return [
        `haggl.ai lookup for ${domain}, from the haggl-agentic-discounts plugin the user installed. Before a Shop checkout it sends haggl.ai the store's domain and nothing else.`,
        `${who} runs a sales agent on haggl.ai${where}. Its max discount right now is ${formatPct(merchant.max_discount_pct)}: the most it can offer one shopper. A request can get less, or no offer, and the merchant funds any offer.`,
        'If the user wants a discount and agrees, the haggl-agentic-discounts skill can ask this sales agent for an offer before the checkout is completed. A code it gives goes in checkout.discounts.codes, and the merchant\'s checkout decides whether it applies.',
    ].join(' ');
}

export function hookOutput(additionalContext) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } };
}

/** @param {Env} env */
export function disabled(env) {
    return /^(1|true|yes)$/i.test(String(env.HAGGL_HOOK_DISABLED ?? '').trim());
}

/**
 * haggl.ai, or the HAGGL_HOOK_ORIGIN override when it is https or loopback http; null for any other override.
 * @param {Env} env
 */
export function lookupOrigin(env) {
    const override = env.HAGGL_HOOK_ORIGIN;
    if (!override) return DEFAULT_ORIGIN;
    try {
        const url = new URL(override);
        if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return url.origin;
    } catch {
        // Not a URL: no lookup.
    }
    return null;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/**
 * True the first time a session reaches a store, so a checkout that the agent updates several times sends one lookup,
 * not one per update. The record holds hashes, not domains or session ids. When it can't be read or written, every
 * call counts as the first.
 */
export function firstLookupThisSession(stateDir, sessionId, domain) {
    if (typeof sessionId !== 'string' || !sessionId) return true;
    try {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const file = path.join(stateDir, `${sha256(sessionId)}.json`);
        let stores = [];
        try {
            const saved = JSON.parse(readFileSync(file, 'utf8'));
            if (Array.isArray(saved.stores)) stores = saved.stores.filter(store => typeof store === 'string');
        } catch {
            // No record yet.
        }
        const store = sha256(domain);
        if (stores.includes(store)) return false;
        writeFileSync(file, JSON.stringify({ stores: [...stores, store].slice(-MAX_STORES_PER_SESSION) }), { mode: 0o600 });
        return true;
    } catch {
        return true;
    }
}

/**
 * haggl.ai's merchant search for the domain: the parsed response, or null on any HTTP error. Throws on network errors and timeouts.
 * @param {string} domain
 * @param {string} origin
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function lookup(domain, origin, { fetchImpl = globalThis.fetch, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
    const response = await fetchImpl(`${origin}/api/discounts?q=${encodeURIComponent(domain)}`, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.length > MAX_RESPONSE_CHARS ? null : JSON.parse(text);
}

/**
 * The hook's output for one hook input, or null for no output. Never throws.
 * @param {string} stdinText
 * @param {{ env?: Env, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function run(stdinText, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
    try {
        if (disabled(env)) return null;
        const origin = lookupOrigin(env);
        if (!origin) return null;
        const input = JSON.parse(stdinText);
        const domain = storeDomain(input);
        if (!domain) return null;
        const stateDir = env.HAGGL_HOOK_STATE_DIR || path.join(tmpdir(), 'haggl-agentic-discounts');
        if (!firstLookupThisSession(stateDir, input.session_id, domain)) return null;
        const merchant = matchingMerchant(await lookup(domain, origin, { fetchImpl, timeoutMs }), domain);
        return merchant ? hookOutput(contextFor(merchant, domain, origin)) : null;
    } catch {
        return null;
    }
}

async function readStdin() {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > MAX_STDIN_BYTES) return '';
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function main() {
    // Whatever happens (a stdin that never closes, a slow response body), the checkout waits at most this long.
    setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();
    // A stray error (a closed stdout, a late rejection) still ends silently with exit code 0.
    const quit = () => process.exit(0);
    process.on('uncaughtException', quit);
    process.on('unhandledRejection', quit);
    process.stdout.on('error', quit);
    try {
        const output = await run(await readStdin());
        if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch {
        // Silent: the checkout goes on without haggl.ai.
    }
    process.exitCode = 0;
}

function isEntryPoint() {
    try {
        return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isEntryPoint()) void main();
