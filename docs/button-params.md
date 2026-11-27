# Button params: inline or stored

Telegram limits callback data to 64 bytes, and modified clients can forge it.
`buttons.params` decides where button params live:

| mode | callback data | forgeable | size |
|---|---|---|---|
| `inline` | `p\|order\|id=42` | yes | throws above 64 bytes |
| `auto` (default) | inline if it fits, else `s\|<token>` | inline ones | unlimited |
| `stored` | `s\|<token>` whenever there are params | no | unlimited |
| `signed` | `p\|order\|id=42&_s=<signature>` | no | inline 64 bytes (overflow is stored) |

A stored button saves `{ target, params, user }` and carries only a
16-character token.
- The token resolves only for the user the button was rendered for, in
  owner-only menus (`buttons.ownerOnly`, default on). Inline-mode messages and
  menus with `allowedUsers` aren't bound to one user.
- Re-rendering the same button reuses its token.
- In `stored` mode, incoming inline params are rejected, so `p|order|id=999`
  sent by a modified client does nothing.
- Pass `{ store: true }` to store the params of a single button.
- A dialogue's buttons (its options' values) are stored when they don't fit,
  in every mode, `inline` included.

**Signed** buttons keep their params inline and add a short HMAC signature, so
they can't be forged and nothing is written to storage when you render:

```ts
new EasyTG({ buttons: { params: 'signed', secret: process.env.BUTTON_SECRET } }); // ≥ 16 characters
```

The signature covers the bot, the chat, the target, the params and, for
owner-only menus, the user. Deep links are signed too, but without a user or
bot, so they can be shared. Keep the secret stable: changing it invalidates the
buttons already in chats.

## Reserved param names

Param names starting with `_` belong to easytg (a button's `{ mode }`, its
signature) and are refused in yours. When your buttons need such names, for
instance to stay byte-identical with buttons an earlier bot already sent
(`p|list|_page=2`), pick another prefix for easytg's own:

```ts
new EasyTG({ buttons: { reservedPrefix: '~' } });
nav.button('➡️', list, { _page: 3 }); // p|list|_page=3
```

Buttons already sent with `{ mode }` or a signature lose them when the prefix
changes, so set it once, before going live.
