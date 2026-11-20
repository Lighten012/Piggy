import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, breaks: true });
markdown.validateLink = href => /^https?:\/\//i.test(href);
// Keep an image's description in the conversation without fetching a remote resource.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);

export const renderMarkdown = source => markdown.render(source);
