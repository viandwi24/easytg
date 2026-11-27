import { describe, expect, test } from 'bun:test';
import { escapeFor, escapeMarkdown, html, htmlToMarkdownV1, htmlToMarkdownV2, md } from '../src';
import { markdownToHtml } from '../src/format';
import { resolveText } from '../src/format';

describe('markdownToHtml', () => {
  const cases: Array<[string, string]> = [
    ['**b** *i* _i_ __u__ ~~s~~ ||sp||', '<b>b</b> <i>i</i> <i>i</i> <u>u</u> <s>s</s> <tg-spoiler>sp</tg-spoiler>'],
    ['**bold *nested* bold**', '<b>bold <i>nested</i> bold</b>'],
    ['snake_case_name and https://a.com/x_y_z', 'snake_case_name and https://a.com/x_y_z'],
    ['5 * 3 = 15, a ** b, unclosed **x', '5 * 3 = 15, a ** b, unclosed **x'],
    ['`a *b* <c>`', '<code>a *b* &lt;c&gt;</code>'],
    ['[docs **x**](https://e.com/a_(b)) end', '<a href="https://e.com/a_(b)">docs <b>x</b></a> end'],
    ['\\*literal\\* & <tag>', '*literal* &amp; &lt;tag&gt;'],
    ['# Title\n- one\n> q **b**\n> two', '<b>Title</b>\n• one\n<blockquote>q <b>b</b>\ntwo</blockquote>'],
    ['```js\nif (a < b) {}\n```', '<pre><code class="language-js">if (a &lt; b) {}</code></pre>'],
  ];
  for (const [input, output] of cases) {
    test(JSON.stringify(input), () => expect(markdownToHtml(input)).toBe(output));
  }
});

describe('md`` / html`` templates', () => {
  const evil = '[free](https://evil.example) **x** <b>&';

  test('md escapes interpolations', () => {
    const out = md`Hi **${evil}**`.html;
    expect(out).toBe('Hi <b>[free](https://evil.example) **x** &lt;b&gt;&amp;</b>');
    expect(out).not.toContain('<a');
  });

  test('md keeps nested md fragments and allows interpolated urls', () => {
    expect(md`${md`*a*`} and [site](${'https://x.com/p?a=1&b=2'})`.html).toBe(
      '<i>a</i> and <a href="https://x.com/p?a=1&amp;b=2">site</a>',
    );
  });

  test('html escapes interpolations and keeps fragments', () => {
    expect(html`<b>${evil}</b> ${md`**m**`}`.html).toBe(
      '<b>[free](https://evil.example) **x** &lt;b&gt;&amp;</b> <b>m</b>',
    );
  });

  test('escapeMarkdown round-trips any text literally', () => {
    const text = '*_[]()~`>#+-=|{}.!\\ <&>';
    expect(markdownToHtml(escapeMarkdown(text))).toBe('*_[]()~`&gt;#+-=|{}.!\\ &lt;&amp;&gt;');
  });
});

describe('resolveText', () => {
  test('plain strings follow the parse mode', () => {
    expect(resolveText(['**a**', 'b'], 'markdown')).toEqual({ text: '<b>a</b>\nb', parse_mode: 'HTML' });
    expect(resolveText('<i>x</i>', 'html')).toEqual({ text: '<i>x</i>', parse_mode: 'HTML' });
    expect(resolveText('*x*', 'markdownv2')).toEqual({ text: '*x*', parse_mode: 'MarkdownV2' });
    expect(resolveText('*x* <y>', 'plain')).toEqual({ text: '*x* <y>' });
  });

  test('fragments switch the message to HTML', () => {
    expect(resolveText([md`**a**`, '<plain>'], 'plain')).toEqual({ text: '<b>a</b>\n&lt;plain&gt;', parse_mode: 'HTML' });
    expect(resolveText([html`<i>h</i>`, '**m**'], 'markdown')).toEqual({ text: '<i>h</i>\n<b>m</b>', parse_mode: 'HTML' });
  });

  test('in markdownv2 and markdownv1, fragments are converted to the mode and mix with its raw strings', () => {
    expect(resolveText(['*raw*', md`Hi **${'a.b_c'}**`], 'markdownv2')).toEqual({ text: '*raw*\nHi *a\\.b\\_c*', parse_mode: 'MarkdownV2' });
    expect(resolveText(['*raw*', md`Hi **${'a_b*c'}**`], 'markdownv1')).toEqual({ text: '*raw*\nHi *a_b*\\**c*', parse_mode: 'Markdown' });
  });
});

describe('converting to MarkdownV2 and legacy Markdown', () => {
  const sample = html`<b>bold</b> <i>it</i> <u>under</u> <s>gone</s> <tg-spoiler>secret</tg-spoiler> <code>a\`b</code> <a href="https://x.dev/(1)">link</a> 1.5!`;

  test('MarkdownV2: every style, escaped text, code and urls', () => {
    expect(htmlToMarkdownV2(sample.html)).toBe('*bold* _it_ __under__ ~gone~ ||secret|| `a\\`b` [link](https://x.dev/(1\\)) 1\\.5\\!');
  });

  test('MarkdownV2: nesting, the italic/underline ambiguity, quotes and code blocks', () => {
    expect(htmlToMarkdownV2('<b>a <i>b</i></b>')).toBe('*a _b_*');
    expect(htmlToMarkdownV2('<i><u>x</u></i>')).toBe('_\r__x__\r_');
    expect(htmlToMarkdownV2('<blockquote>one\ntwo</blockquote>')).toBe('>one\n>two');
    expect(htmlToMarkdownV2('<blockquote expandable>one\ntwo</blockquote>')).toBe('**>one\n>two||');
    expect(htmlToMarkdownV2('<pre><code class="language-ts">let a = `x`;</code></pre>')).toBe('```ts\nlet a = \\`x\\`;\n```');
    expect(htmlToMarkdownV2('a &lt;b&gt; &amp; c')).toBe('a <b\\> & c');
  });

  test('legacy Markdown: what it supports, the text of the rest, no nesting', () => {
    expect(htmlToMarkdownV1(sample.html)).toBe('*bold* _it_ under gone secret `aˋb` [link](https://x.dev/(1%29) 1.5!');
    expect(htmlToMarkdownV1('<b>a <i>b</i></b> x_y')).toBe('*a b* x\\_y');
    expect(htmlToMarkdownV1('<i>snake_case</i>')).toBe('_snake_\\__case_');
    expect(htmlToMarkdownV1('<a href="https://x.dev">[1]</a>')).toBe('\\[1]');
  });

  test('md fragments work in every parse mode, with values escaped for it', () => {
    const name = '*Ann_[x]*';
    const fragment = md`Hi **${name}**`;
    expect(resolveText(fragment, 'markdown').text).toBe('Hi <b>*Ann_[x]*</b>');
    expect(resolveText(fragment, 'html').text).toBe('Hi <b>*Ann_[x]*</b>');
    expect(resolveText(fragment, 'markdownv2').text).toBe('Hi *\\*Ann\\_\\[x\\]\\**');
    expect(resolveText(fragment, 'markdownv1').text).toBe('Hi \\**Ann_[x]*\\*');
  });

  test('escapeFor escapes for each mode', () => {
    expect(escapeFor('markdownv2', 'a.b')).toBe('a\\.b');
    expect(escapeFor('markdownv1', 'a_b')).toBe('a\\_b');
    expect(escapeFor('html', '<a>')).toBe('&lt;a&gt;');
    expect(escapeFor('plain', '*x*')).toBe('*x*');
  });
});
