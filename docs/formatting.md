# Text formatting

Plain strings are parsed with the app's `parseMode`, which you can override per
content or per step:

| `parseMode` | meaning |
|---|---|
| `markdown` (default) | `**bold**` `*italic*` `_italic_` `__underline__` `~~strike~~` `\|\|spoiler\|\|` `` `code` `` ```` ```pre``` ```` `[text](url)` `> quote` `# heading` `- bullet` |
| `html` | raw Telegram HTML |
| `markdownv2` | raw Telegram MarkdownV2 |
| `plain` | no formatting |

The Markdown dialect is predictable:
- `_` inside words (`snake_case`, URLs) never becomes italic.
- Unmatched markers are shown as-is.
- `\` escapes the next character, except in code: inside `` `code` `` and
  code blocks, text is shown as written (only `\\` and `` \` `` are escapes),
  so `` `\d+` `` stays `\d+`.
- Code blocks take any language name: ```` ```c++ ````, ```` ```c# ````.

**Put user data in `md` / `html` templates.** They escape every interpolated
value, so a user named `[free](https://evil)` can't inject a link:

```ts
text: md`Hello **${user.name}**, you owe ${amount}`
text: html`Hello <b>${user.name}</b>`
text: [md`**${title}**`, 'a plain line follows parseMode']  // mixing is fine (not with parseMode 'markdownv2')
```

Fragments nest: `md` keeps nested `md` fragments, `html` keeps nested `md`
and `html` fragments. An `html` fragment inside `md` is escaped (its tags
show as text).

`escapeMarkdown`, `escapeHTML` and `escapeMarkdownV2` are also available for
manual escaping.
