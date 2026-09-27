import { describe, expect, test } from 'bun:test';
import { escapeMarkdown, html, md } from '../src';
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
    expect(() => resolveText([md`a`, 'b'], 'markdownv2')).toThrow();
  });
});
