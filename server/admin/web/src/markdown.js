import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, breaks: true });
const cjk = /[㐀-鿿豈-﫿ぁ-ヿ가-힣]/u;
const opening = /[“‘「『《〈（【〔]/u;
const closing = /[”’」』》〉）】〕，。！？：；、]/u;

// Permit strong emphasis at an unspaced CJK text/quotation boundary.
// Keep the parser's usual handling of escaping, code, and delimiter pairing.
markdown.inline.State = class extends markdown.inline.State {
  scanDelims(start, canSplitWord) {
    const scanned = super.scanDelims(start, canSplitWord);
    if (this.src[start] !== "*" || scanned.length !== 2) return scanned;
    const before = this.src[start - 1] ?? "";
    const after = this.src[start + 2] ?? "";
    if (cjk.test(before) && opening.test(after)) scanned.can_open = true;
    if (closing.test(before) && cjk.test(after)) scanned.can_close = true;
    return scanned;
  }
};
markdown.validateLink = href => /^https?:\/\//i.test(href);
// Keep an image's description in the conversation without fetching a remote resource.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

export const renderMarkdown = source => markdown.render(source);
