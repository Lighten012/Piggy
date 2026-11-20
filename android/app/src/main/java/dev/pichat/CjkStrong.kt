package dev.pichat

import org.commonmark.internal.InlineParserImpl
import org.commonmark.node.*
import org.commonmark.parser.InlineParser
import org.commonmark.parser.InlineParserContext
import java.util.UUID

private const val cjk = "[㐀-鿿豈-﫿ぁ-ヿ가-힣]"
private val opening = Regex("($cjk\\*\\*)([“‘「『《〈（【〔])")
private val closing = Regex("([”’」』》〉）】〕，。！？：；、])(\\*\\*$cjk)")

// CommonMark 0.13 does not expose its delimiter scanner. Guard the punctuation
// while it pairs the stars, then remove the guard from the parsed inline nodes.
internal fun cjkInlineParser(context: InlineParserContext): InlineParser {
    val standard = InlineParserImpl(context)
    return InlineParser { source, parent ->
        if (!source.contains("**") || (!opening.containsMatchIn(source) && !closing.containsMatchIn(source))) {
            standard.parse(source, parent)
        } else {
            val guard = "\uE000" + UUID.randomUUID().toString() + "\uE001"
            fun restore(value: String) = value.replace(guard, "", ignoreCase = true)
            val wrapped = opening.replace(source) { it.groupValues[1] + guard + it.groupValues[2] }
            val input = closing.replace(wrapped) { it.groupValues[1] + guard + it.groupValues[2] }
            // Reference definitions are indexed by their original labels.
            val references = object : InlineParserContext by context {
                override fun getLinkReferenceDefinition(label: String) =
                    context.getLinkReferenceDefinition(restore(label))
            }
            InlineParserImpl(references).parse(input, parent)
            parent.accept(object : AbstractVisitor() {
                override fun visit(text: Text) { text.literal = restore(text.literal) }
                override fun visit(code: Code) { code.literal = restore(code.literal) }
                override fun visit(html: HtmlInline) { html.literal = restore(html.literal) }
                override fun visit(link: Link) {
                    link.destination = restore(link.destination)
                    link.title = link.title?.let(::restore)
                    visitChildren(link)
                }
                override fun visit(image: Image) {
                    image.destination = restore(image.destination)
                    image.title = image.title?.let(::restore)
                    visitChildren(image)
                }
            })
        }
    }
}
