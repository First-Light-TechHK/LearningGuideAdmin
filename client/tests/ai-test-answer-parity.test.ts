// Behavioral cases ported from Portal's Tutor answer tests.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ChatAnswer } from '../src/components/ai/ChatAnswer'
import { tutorAnswerParts, tutorAnswerPlainText, tutorAnswerSegments } from '../src/components/ai/chatAnswerParts'

const render = (content: string, courseId = 'course-1') =>
  renderToStaticMarkup(createElement(ChatAnswer, { content, courseId }))

const katexCount = (html: string) => (html.match(/class="katex"/g) || []).length;
const IMAGE = "![图](/api/files/images/course-1/22222222-2222-4222-8222-222222222222.png)";

test("numbered sources from older Portal replies render once in their original order", () => {
  const text = "Claim [1].\n\n**Sources**\n**[1] Lesson 1&#x20;** **[2] Lesson 2**";
  assert.match(render(text), /<p>Claim \[1\]\.<\/p><div class="tutor-answer-sources"><p>Sources<\/p><p>\[1\] Lesson 1<\/p><p>\[2\] Lesson 2<\/p>/);
});

test("an indented lesson explanation can follow an image without consuming its list, source or fenced code", () => {
  const text = IMAGE + "\n\n    **标量**是一个数。[1]\n    - 正数方向不变\n\n    Sources\n    [1] Lesson 1\n\n~~~text\n    **code**\n~~~";
  const html = render(text);
  assert.match(html, /<img [^>]*>[\s\S]*<p><strong>标量<\/strong>是一个数。\[1\]<\/p>\s*<ul>\s*<li>正数方向不变<\/li>/);
  assert.match(html, /<pre><code class="language-text">    \*\*code\*\*\n<\/code><\/pre>/);
  assert.match(html, /<p>Sources<\/p><p>\[1\] Lesson 1<\/p>/);
});

test("formula rule: money stays money, in English and Chinese, beside a real formula and in a range", () => {
  for (const text of ["A book costs $5 and a pen costs $10.", "书 $5，笔 $10，一共 $15。", "Between $3-$4 each.", "Spaced $ x $ is not a formula."]) {
    const html = render(text);
    assert.equal(katexCount(html), 0, text);
    assert.match(html, new RegExp(`<p>${text.replace(/[$.()*+?[\]\\^{}|-]/g, "\\$&")}</p>`), text);
  }
  const mixed = render("It costs $5. The area is $x^2$.");
  assert.equal(katexCount(mixed), 1);
  assert.match(mixed, /<p>It costs \$5\. The area is <span class="katex">/);
});

test("formula rule: $ … $, \\( … \\), \\[ … \\], $$ … $$ inline and on their own lines are formulas; \\$ is a dollar sign", () => {
  assert.equal(katexCount(render("Power $x^n$ and $a+b$.")), 2);
  assert.equal(katexCount(render("Inline \\(x^2\\) and $$y^2$$ here")), 2);
  assert.doesNotMatch(render("Inline $$y^2$$ here"), /katex-display/, "$$ … $$ inside a line stays inline");
  const display = render("Then\n\\[\na+b\n=c\n\\]\nDone");
  assert.match(display, /<p>Then<\/p>\s*<span class="katex-display">[\s\S]*<p>Done<\/p>/);
  const escaped = render("Price \\$5 and \\$6.");
  assert.equal(katexCount(escaped), 0);
  assert.match(escaped, /<p>Price \$5 and \$6\.<\/p>/);
});

test("formula rule: \\[ … \\] inside a sentence around plain words is escaped brackets; with TeX in it, or on its own line, it is a formula", () => {
  const brackets = render("Array index \\[1\\] means the second item.");
  assert.equal(katexCount(brackets), 0);
  assert.match(brackets, /<p>Array index \[1\] means the second item\.<\/p>/);
  assert.match(render("The interval \\[a, b\\] is closed."), /<p>The interval \[a, b\] is closed\.<\/p>/);
  assert.equal(tutorAnswerPlainText("Array index \\[1\\] here", "Sources"), "Array index [1] here");
  assert.match(render("So \\[x=1\\] holds."), /katex-display/);
  assert.match(render("So \\[\\alpha\\] holds."), /katex-display/);
  assert.match(render("\\[1\\]"), /katex-display/);
  assert.match(render("Value:\n\\[x\\]\nDone"), /<p>Value:<\/p>\s*<span class="katex-display">/);
});

test("formula rule: a $$ block keeps lines that look like a table or a list, and a formula may wrap a line", () => {
  const { markdown } = tutorAnswerParts("Abs:\n$$\n|x| = -x\n- y\n$$\nEnd");
  assert.equal(markdown, "Abs:\n\n$$\n|x| = -x\n- y\n$$\n\nEnd");
  const html = render("Abs:\n$$\n|x| = -x\n- y\n$$\nEnd");
  assert.doesNotMatch(html, /<table|<ul/);
  assert.equal(katexCount(render("Sum \\(a +\nb\\) ok")), 1);
});

test("formula rule: code is never read as a formula, and a citation inside code stays", () => {
  const html = render("Run `echo $HOME` and $x$; `[Source: x]` [Source: Real]");
  assert.match(html, /<code>echo \$HOME<\/code>/);
  assert.match(html, /<code>\[Source: x\]<\/code>/);
  assert.equal(katexCount(html), 1);
  assert.match(html, /<p>Sources<\/p><p>Real<\/p>/);
  assert.deepEqual(tutorAnswerSegments("`$a$` $b$").segments.map((segment) => segment.kind), ["code", "prose", "math"]);
});

test("code rule: indentation never makes a code block (prose after an image, tabs, numbered lines, nested lists)", () => {
  const cases: Array<[string, RegExp]> = [
    ["The answer is below.\n    This line is indented by four spaces.", /<p>The answer is below\.<\/p>\s*<p>This line is indented by four spaces\.<\/p>/],
    [`${IMAGE}\n    After the image the text is indented.\n    Second indented line.`, /<img [^>]*>[\s\S]*<p>After the image the text is indented\.<\/p>\s*<p>Second indented line\.<\/p>/],
    ["Intro\n\tTabbed line", /<p>Intro<\/p>\s*<p>Tabbed line<\/p>/],
    ["Intro\n    1. first\n    2. second", /<p>Intro<\/p>\s*<ol>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ol>/],
    ["- a\n    - b\n- c", /<ul>\s*<li>a\s*<ul>\s*<li>b<\/li>/],
  ];
  for (const [text, shape] of cases) {
    const html = render(text);
    assert.doesNotMatch(html, /<pre/, text);
    assert.match(html, shape, text);
  }
  // A fence is still code, with its spaces and blank lines.
  assert.match(render("Code:\n~~~\n  x  \n\n\n~~~\nAfter"), /<p>Code:<\/p>\s*<pre><code> {2}x {2}\n\n\n<\/code><\/pre>\s*<p>After<\/p>/);
});

test("line rule: every line is its own paragraph, and bold, italics, links and formulas that wrap a line stay whole", () => {
  assert.match(render("One\nTwo\nThree"), /<p>One<\/p>\s*<p>Two<\/p>\s*<p>Three<\/p>/);
  assert.match(render("Line one  \nLine two"), /<p>Line one<\/p>\s*<p>Line two<\/p>/);
  assert.match(render("**Key\npoint** here"), /<p><strong>Key\npoint<\/strong> here<\/p>/);
  assert.match(render("*a\nb*"), /<p><em>a\nb<\/em><\/p>/);
  assert.match(render("[a\nb](https://x.test)"), /<p><a href="https:\/\/x\.test" target="_blank" rel="noopener noreferrer">a\nb<\/a><\/p>/);
  assert.doesNotMatch(render("**Key\npoint**"), /\*\*/);
});

test("line rule: lists, tables, quotes and headings keep their own lines and do not swallow the prose after them", () => {
  assert.match(render("Rules:\n- sum\n- product\nDone"), /<p>Rules:<\/p>\s*<ul>\s*<li>sum<\/li>\s*<li>product<\/li>\s*<\/ul>\s*<p>Done<\/p>/);
  assert.match(render("Intro\n2. two\n3. three"), /<ol start="2">/);
  assert.match(render("Table:\n| a | b |\n|---|---|\n| 1 | 2 |\nAfter table"), /<p>Table:<\/p>\s*<table>[\s\S]*<\/table>\s*<p>After table<\/p>/);
  assert.match(render("Said:\n> one\n> two\nAfter quote"), /<p>Said:<\/p>\s*<blockquote>\s*<p>one<\/p>\s*<p>two<\/p>\s*<\/blockquote>\s*<p>After quote<\/p>/);
  assert.match(render("## Steps\nText"), /<h2>Steps<\/h2>\s*<p>Text<\/p>/);
  // A list item with a second line shows it on its own line.
  assert.match(render("1. First\n   more\n2. Second\nDone"), /<li>\s*<p>First<\/p>\s*<p>more<\/p>\s*<\/li>[\s\S]*<\/ol>\s*<p>Done<\/p>/);
});

test("streaming: an answer cut inside a fence, a $$ block, \\( or $ still renders", () => {
  assert.match(render("Intro\n```js\nconst a = 1;"), /<pre><code class="language-js">const a = 1;/);
  assert.match(render("Intro\n$$\nx^2"), /katex-display/);
  assert.match(render("Consider $x^2 +"), /<p>Consider \$x\^2 \+<\/p>/);
  assert.equal(katexCount(render("Consider \\(x^2 +")), 0);
});

test("sources: an indented or Chinese closing list is found, and nothing else changes", () => {
  assert.deepEqual(tutorAnswerParts("Text\n\n    Sources\n    [1] L1\n    [2] L2"), { markdown: "Text", sources: ["[1] L1", "[2] L2"] });
  assert.deepEqual(tutorAnswerParts("正文\n来源：\n[1] 第一课"), { markdown: "正文", sources: ["[1] 第一课"] });
  assert.deepEqual(tutorAnswerParts("x [Source: L1] y [来源：L1]"), { markdown: "x y", sources: ["L1"] });
  assert.equal(tutorAnswerParts("See [1] in the text").markdown, "See [1] in the text");
});

test("arithmetic and identifiers: 2*3*4, x_1 and snake_case stay as written; raw HTML stays text", () => {
  assert.match(render("2*3*4 = 24 and **bold**"), /<p>2\*3\*4 = 24 and <strong>bold<\/strong><\/p>/);
  assert.match(render("x_1 and snake_case and __bold__"), /<p>x_1 and snake_case and <strong>bold<\/strong><\/p>/);
  assert.match(render("<b>x</b> & y"), /<p>&lt;b&gt;x&lt;\/b&gt; &amp; y<\/p>/);
  assert.match(render("\n\n\nOnly\n\n\n"), /^<div class="tutor-answer" data-testid="tutor-answer"><p>Only<\/p><\/div>$/);
});

test("plain text copy reads the answer the same way: formulas as TeX, code as written, no Markdown marks, sources at the end", () => {
  assert.equal(tutorAnswerPlainText("2*3*4 = 24, x_1 and snake_case are **key**; *really*.", "Sources"), "2*3*4 = 24, x_1 and snake_case are key; really.");
  assert.equal(tutorAnswerPlainText("A book costs $5. Area \\(x^2\\) and $y_1$.", "Sources"), "A book costs $5. Area x^2 and y_1.");
  assert.equal(tutorAnswerPlainText(`${IMAGE}\n    Indented prose [link](https://x.test)`, "Sources"), "图\nIndented prose link");
  assert.equal(tutorAnswerPlainText("Code:\n```py\n  x = 1\n\n\ny = 2\n```\nDone", "Sources"), "Code:\n  x = 1\n\n\ny = 2\nDone");
  assert.equal(tutorAnswerPlainText("Run `a*b*c` now", "Sources"), "Run a*b*c now");
  assert.equal(tutorAnswerPlainText("Claim [Source: Lesson 1]\n\nSources\n[1] Lesson 2", "来源"), "Claim\n\n来源\n[1] Lesson 2\nLesson 1");
  assert.equal(tutorAnswerPlainText("Consider \\[\na+b\n\\] done", "Sources"), "Consider\na+b\ndone");
});


test("D1: fenced code keeps its own lines, blank lines and backslashes; prose around it still gets one paragraph per line", () => {
  const code = "```python\nx = 1\n\n\n# \\(not math\\) [Source: not a citation]\nprint(2*3)\n```";
  const { markdown, sources } = tutorAnswerParts(`First point\nSecond point\n${code}\nAfter`);
  // Prose lines become paragraphs after parsing (remarkTutorLines); the text only marks block edges.
  assert.equal(markdown, `First point\nSecond point\n\n${code}\n\nAfter`);
  assert.deepEqual(sources, []);
  const html = render(`First point\nSecond point\n${code}\nAfter`);
  assert.match(html, /<p>First point<\/p>\s*<p>Second point<\/p>\s*<pre><code class="language-python">x = 1\n\n\n# \\\(not math\\\) \[Source: not a citation\]\nprint\(2\*3\)\n<\/code><\/pre>\s*<p>After<\/p>/);
});

test("D1: inline code is not rewritten; the prose beside it is", () => {
  const { markdown, sources } = tutorAnswerParts("Use `a\\(b\\)` and \\(x^2\\) with 2*3 [Source: Lesson 1]");
  assert.equal(markdown, "Use `a\\(b\\)` and $x^2$ with 2\\*3");
  assert.deepEqual(sources, ["Lesson 1"]);
});

test("D1: a streaming answer cut inside a fence or a $$ block still parses", () => {
  assert.equal(tutorAnswerParts("Intro\n```js\nconst a = 1;").markdown, "Intro\n\n```js\nconst a = 1;");
  assert.equal(tutorAnswerParts("Intro\n$$\nx^2").markdown, "Intro\n\n$$\nx^2\n$$");
});

test("D1: quote lines stay one quote", () => {
  assert.equal(tutorAnswerParts("Said:\n> one\n> two").markdown, "Said:\n\n> one\n> two");
});

test("D2: links only to http(s), in a new tab with no referrer; anything else is plain text", () => {
  const html = render("[ok](https://example.test/a) [mail](mailto:x@example.test) [rel](/en-GB/portal)");
  assert.match(html, /<a href="https:\/\/example\.test\/a" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.doesNotMatch(html, /href="mailto:|href="\/en-GB/);
  assert.match(html, /<span>mail<\/span> <span>rel<\/span>/);
});

test("D2: KaTeX renders HTML only, so the formula's text is not there twice", () => {
  const html = render("Power rule $(x^n)'=nx^{n-1}$");
  assert.match(html, /class="katex-html"/);
  assert.doesNotMatch(html, /katex-mathml/);
});

test("AI Test renders the common Markdown formats from Portal", () => {
  const asset = "22222222-2222-4222-8222-222222222222.png";
  const html = render(`# Heading\n**bold** *italic* ~~old~~\n- [x] done\n- [ ] pending\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> quoted\n\n---\n\n\`inline\`\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n\n![chart](/api/files/images/course-1/${asset})\n\nInline \\(x^2\\) and block:\n\\[\\frac{1}{2}\\]`, "course-1");
  for (const tag of ["h1", "strong", "em", "del", "ul", "table", "blockquote", "pre"]) assert.match(html, new RegExp(`<${tag}(?: |>)`), tag);
  assert.match(html, /<hr\/>/);
  assert.match(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, new RegExp(`/api/files/images/course-1/${asset}`));
  assert.match(html, /class="katex-display"/);
  assert.match(html, /class="katex"/);
});

test("Markdown continuation lines stay in their list items and answer lines use the shared paragraph rule", () => {
  const html = render("- first item\n  continued detail\n- second item\n\nline one  \nline two");
  assert.match(html, /<li>\s*<p>first item<\/p>\s*<p>continued detail<\/p>\s*<\/li>/);
  assert.match(html, /<p>line one<\/p>\s*<p>line two<\/p>/);
});

test("D2: the answer and its sources use the shared class names, nothing page-specific", () => {
  const html = render("Claim [Source: Modeling Life - 2.2]");
  assert.match(html, /^<div class="tutor-answer" data-testid="tutor-answer"><p>Claim<\/p><div class="tutor-answer-sources"><p>Sources<\/p><p>Modeling Life - 2\.2<\/p><\/div><\/div>$/);
});


test("historical overescaped answers renders fractions and equations without rewriting the input",()=>{
 const text=String.raw`正确给出了比例，即鹰占 \\(\\frac{2}{3}\\)，鸽子占 \\(\\frac{1}{3}\\)。等式为 \\(2 - 2.5x = 1 - x\\)。`;
 const before=JSON.stringify(text),html=render(text);assert.equal((html.match(/class="katex"/g)||[]).length,3);assert.equal(html.includes("katex-error"),false);assert.equal(JSON.stringify(text),before);
});
test("normal and fully escaped matrices preserve their row separators",()=>{
 const tex=String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`;
 for(const text of [String.raw`\[${tex}\]`,String.raw`\\[${tex}\\]`,String.raw`\\[${tex.replace(/\\/g,"\\\\")}\\]`]){
  const math=tutorAnswerSegments(text).segments.find(s=>s.kind==="math");assert.ok(math&&math.kind==="math");assert.equal(math.tex,tex);const html=render(text);assert.ok(html.includes('class="katex"'));assert.equal(html.includes("katex-error"),false);
 }
});
test("code, currency and ordinary TeX line breaks remain literal or unchanged",()=>{
 const code=String.raw`\\(\\frac{2}{3}\\)`;
 const html=render('`'+code+'`');assert.ok(html.includes('<code>'));assert.equal(html.includes('class="katex"'),false);
 assert.equal(render(String.raw`价格 \$5 和 \$10`).includes('class="katex"'),false);
 const tex=String.raw`a\\b`;const segment=tutorAnswerSegments(String.raw`\(${tex}\)`).segments[0];assert.ok(segment.kind==="math");assert.equal(segment.tex,tex);
});
