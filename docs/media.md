# Media

A page (or dialogue step) can show one media item, with `text` as its caption:

```ts
{ photo: 'AgACAgIAAx…', text: 'A photo' }             // file_id
{ video: 'https://example.com/clip.mp4', text: '…' }  // URL
{ animation: gifFileId }                              // GIF / silent MP4
{ document: new InputFile(buffer, 'report.pdf') }     // generated or local file
{ audio: songFileId }
```

- Use at most one of `photo`, `video`, `animation`, `document`, `audio`,
  `album`, `copy` and `invoice` per page; combining them throws.
- Switching between pages edits the media in place (`editMessageMedia`); the
  same file only updates the caption.
- Captions longer than 1024 characters continue in a text message.
- Media → text-only pages replace the message (unless `buttons.mediaToText: 'keep'`
  or a button with `{ mode: 'send' }`, see [Pages](pages.md#keeping-the-pressed-message)).
- `deleteAfterMs` makes a media message delete itself later, e.g. a video
  that should only be available for a while.

**Copying** an existing message is often better than uploading: nothing is
re-uploaded, there is no "forwarded from" header, and the original can live in a
private channel the bot reads (a media library, an archive):

```ts
{
  copy: { fromChatId: -1001234567890, messageId: 42 },
  text: 'New caption',          // optional: without it the original caption stays
  protectContent: true,         // optional: no forwarding or saving
  keyboard: [[nav.button('Next', item, { n: 43 })]],
}
```

Copies can't be edited into an existing message, so they are always sent as
new messages. `protectContent` works on every kind of content, and
`new EasyTG({ protectContent: true })` turns it on for everything (pages can
still set `protectContent: false`).

**Albums** show 2–10 items as one group:

```ts
{
  album: [
    { type: 'photo', media: p1 },
    { type: 'photo', media: p2 },
    { type: 'video', media: v1 },
  ],
  text: 'Our bestsellers',
  keyboard: [[nav.back()]],
}
```

Telegram doesn't allow buttons on albums. With a `keyboard`, the text and
buttons follow in their own message (so `text` is required then); without
one, `text` becomes the album caption. Pressing a button under an album edits that message and deletes the
album.

## File id cache

Media given by URL is downloaded by Telegram on every send. With
`cacheFileIds`, easytg remembers the `file_id` Telegram assigns to it and sends
that next time, which is faster and doesn't depend on your URL staying up:

```ts
new EasyTG({ media: { cacheFileIds: true, cacheTtlMs: 30 * 24 * 3600_000 } });
```

The ids are kept per bot (a file id only works for the bot that received it)
in `buttons.storage`. If Telegram stops accepting a cached id, the URL is sent
again. Albums are sent by URL as before.
