---
layout: page
sidebar: false
footer: false
title: Playground
pageClass: playground-full
---

<div class="playground-page">
<ClientOnly><Playground picker fill /></ClientOnly>
</div>

<style>
.playground-page {
  padding: 12px 16px 24px;
}
/* Full screen under the navbar: the playground scrolls inside, not the page. */
@media (min-width: 960px) {
  .playground-page {
    height: calc(100dvh - var(--vp-nav-height));
    padding: 12px 16px;
  }
}
</style>
