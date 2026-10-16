# haggl.ai agentic discounts

A plugin for Claude Code and Cowork. When you ask your agent for a discount at a store, it can ask that merchant's
sales agent on haggl.ai for an offer. The merchant funds the offer, inside a budget and max discount it sets, and may
make no offer for a given request.

**Status:** haggl.ai's discount search and haggl ID go live with haggl.ai's next website release. Until then the hook
stays silent and the skill finds no merchants.

## What's in it

- **A skill, `haggl-agentic-discounts`.** Your agent uses it when you ask for a discount, a promo or coupon code, or a
  lower price from a business or for a product, or when you ask to see your haggl.ai offers. It searches the merchants
  that run a sales agent on haggl.ai, tells you the merchant's max discount, and asks that sales agent for an offer for
  you. It shares only what you agree to share, accepts an offer only when you approve it, and keeps a haggl ID for you
  only if you agree to its consent text. The same skill is published at
  <https://www.haggl.ai/agentic-discounts/SKILL.md>.
- **The haggl.ai connector**, `https://www.haggl.ai/api/mcp` (a remote MCP server over HTTP). Its tools search
  merchants, open a negotiation with a merchant's sales agent, send what you ask for, accept an offer, and create, read
  or delete your haggl ID.
- **A hook before Shop's checkout.** Shopify's Shop skill lets your agent buy from Shopify stores through Shop's own
  checkout. When your agent calls Shop's `create_checkout` or `update_checkout`, the hook asks haggl.ai whether that
  store runs a sales agent on haggl.ai. If it does, with a max discount above zero, your agent gets a short note next
  to Shop's result. For a store named Example Store at example-store.com, the note reads:

  > haggl.ai lookup for example-store.com, from the haggl-agentic-discounts plugin the user installed. Before a Shop
  > checkout it sends haggl.ai the store's domain and nothing else. Example Store runs a sales agent on haggl.ai
  > (vendor_id "example-store", https://www.haggl.ai/agentic-discounts/example-store). Its max discount right now is
  > 12%: the most it can offer one shopper. A request can get less, or no offer, and the merchant funds any offer. If
  > the user wants a discount and agrees, the haggl-agentic-discounts skill can ask this sales agent for an offer
  > before the checkout is completed. A code it gives goes in checkout.discounts.codes, and the merchant's checkout
  > decides whether it applies.

  A demo merchant is named as one of haggl.ai's demo merchants. The hook never changes, blocks or approves the
  checkout: Shop gets exactly what your agent sent. Your agent decides with you whether to ask for an offer.

## What leaves your machine

The hook:

- sends haggl.ai one thing, the store's domain, as `GET https://www.haggl.ai/api/discounts?q=<domain>` with the
  User-Agent `haggl-agentic-discounts-hook`;
- does so only when your agent is about to call Shop's `create_checkout` or `update_checkout`, and at most once per
  store in a session;
- sends nothing else from the checkout: no products, cart, prices, address, email, phone number, payment details,
  Shop account data or conversation;
- waits at most 2 seconds for an answer, then lets the checkout go on without one. Any error does the same.

Like any web request, the lookup reaches haggl.ai with your IP address. On your machine, the hook keeps a list of the
stores it already looked up in the session, as hashes, in a `haggl-agentic-discounts` folder in your system's temporary
directory.

The skill and the connector talk to haggl.ai only after you ask for a discount or for your offers, or ask your agent to
check haggl.ai before you buy. They send the business you named, what you want, and what you agree to share. With your approval, that can include email receipts as
proof: haggl.ai checks each email's signature and keeps a fingerprint of it, not the email. Read haggl.ai's privacy
policy at <https://www.haggl.ai/privacy>.

## Install

### Claude Code

From haggl.ai's marketplace, inside Claude Code:

```text
/plugin marketplace add raphacoh/haggl-agentic-discounts
/plugin install haggl-agentic-discounts@haggl.ai
```

or from a shell:

```bash
claude plugin marketplace add raphacoh/haggl-agentic-discounts
claude plugin install haggl-agentic-discounts@haggl.ai
```

To try a local copy instead, clone this repository and start Claude Code with `claude --plugin-dir <the clone>`.

The hook needs Node.js 18 or later on your `PATH`. Without it, the hook doesn't run and the checkout goes on as usual.

### Cowork and claude.ai

In claude.ai, open **Customize > Plugins > Add**, then choose **Add marketplace** with this repository's URL, or
**Upload plugin** with a zip of this folder. Then connect the haggl.ai connector from the plugin's **Connectors** tab.
The skill and the connector work in chat, Cowork and Claude Code. Hooks run in Cowork and Claude Code; chat ignores
them. We have run the hook in Claude Code, not yet in Cowork.

### Codex and Cursor

- **Codex**: its hooks documentation says Codex reads `hooks/hooks.json` from a plugin's root, sets
  `CLAUDE_PLUGIN_ROOT`, names MCP tools `mcp__<server>__<tool>`, and runs a plugin's hooks only after you review and
  trust them in `/hooks`. The hook may therefore work there, but we haven't tested it, and this plugin has no Codex
  manifest yet.
- **Cursor**: Cursor's hook before an MCP call can allow, deny or ask, but can't add context for the agent, and
  Cursor's CLI ignores hooks from marketplace plugins. This hook doesn't work in Cursor.

## Turn the hook off

- Set `HAGGL_HOOK_DISABLED=1`, either in the environment Claude Code starts in (for example
  `export HAGGL_HOOK_DISABLED=1` in your shell profile) or in the `env` of your Claude Code settings, such as
  `~/.claude/settings.json`:

  ```json
  { "env": { "HAGGL_HOOK_DISABLED": "1" } }
  ```

  The hook then exits without a lookup, and the skill and the connector keep working.
- Or turn off the whole plugin: `/plugin disable haggl-agentic-discounts@haggl.ai` in Claude Code, or
  **Customize > Plugins** in claude.ai and Cowork.

## Files

| File | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | The manifest |
| `skills/haggl-agentic-discounts/SKILL.md` | The skill |
| `.mcp.json` | The haggl.ai connector |
| `hooks/hooks.json` | The hook, matched to Shop's `create_checkout` and `update_checkout` under the names Claude Code gives them |
| `hooks/shop-checkout.mjs` | The hook's script, with no dependencies |

## Updates and support

haggl.ai publishes this repository from its own source, where the skill is the same text as
haggl.ai/agentic-discounts/SKILL.md; each release raises `version` in `.claude-plugin/plugin.json`. For help, open an
issue here or write to contact@haggl.ai. The plugin is released under the MIT license (`LICENSE`).
