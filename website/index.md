---
layout: home

hero:
  name: easytg
  text: Telegram bot UIs, built from pages
  tagline: Describe screens and forms. easytg sends, edits and answers them on top of grammY. Try every example right here, in a Telegram simulator that runs in your browser.
  image:
    src: /logo.svg
    alt: easytg
  actions:
    - theme: brand
      text: Get started
      link: /docs/getting-started
    - theme: alt
      text: Open the playground
      link: /playground
    - theme: alt
      text: GitHub
      link: https://github.com/viandwi24/easytg

features:
  - icon: 🧩
    title: Pages, not handlers
    details: One definition per screen. The same page is sent, replied or edited in place, with Back and typed params.
  - icon: 📝
    title: Dialogues
    details: Multi-step forms with choices, text, files, contacts and locations. Answers are typed from the steps.
  - icon: 💾
    title: Sessions and storage
    details: State per chat, per user and per group, in memory, SQLite or Redis, safe across several processes.
  - icon: ⏱️
    title: Beyond one update
    details: Scheduled tasks, queues, broadcasts, payments, inline mode, Mini Apps, rate limits and loading indicators.
  - icon: 🧪
    title: Testable
    details: A fake Telegram API for unit tests, and a full simulator for tests and previews.
  - icon: 🌐
    title: Runs in the browser
    details: No Node-only APIs. The playgrounds on this site run the real library, fully client-side.
---

<div class="playground-home">

## Try it

This is `examples/getting-started.ts`, running in your browser. Press the
buttons, type into the chat, or change the code and press **Run**.

<ClientOnly><Playground example="getting-started" /></ClientOnly>

</div>
