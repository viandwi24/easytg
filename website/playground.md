---
layout: page
sidebar: false
title: Playground
---

<div class="playground-page">

# Playground

Every example from the repository's [`examples/`](https://github.com/viandwi24/easytg/tree/main/examples)
folder that works without a server, running in a Telegram simulator in your
browser. The code is unchanged: the same file runs with
`BOT_TOKEN=… bun run examples/<file>.ts`. Edit it and press **Run**
(⌘/Ctrl + Enter). Nothing is sent to Telegram. Pick an example below; the
chat's ⋮ menu clears its history.

<ClientOnly><Playground picker /></ClientOnly>

</div>

<style>
.playground-page {
  max-width: 1280px;
  margin: 0 auto;
  padding: 32px 24px 64px;
}
.playground-page h1 {
  font-size: 32px;
  font-weight: 700;
  margin-bottom: 12px;
}
.playground-page > p {
  color: var(--vp-c-text-2);
  max-width: 760px;
}
</style>
