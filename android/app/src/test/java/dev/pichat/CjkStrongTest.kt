package dev.pichat

import org.commonmark.node.*
import org.commonmark.parser.Parser
import org.junit.Assert.*
import org.junit.Test

class CjkStrongTest {
    private val parser = Parser.builder().inlineParserFactory(::cjkInlineParser).build()
    private fun bold(source: String): List<String> {
        val phrases = mutableListOf<String>()
        parser.parse(source).accept(object : AbstractVisitor() {
            override fun visit(strong: StrongEmphasis) {
                phrases += (strong.firstChild as Text).literal
            }
        })
        return phrases
    }

    @Test fun cjkBoundaries() {
        assertEquals(listOf("“猫猫狗狗一起吃蛋挞”的配套头像"), bold("一对**“猫猫狗狗一起吃蛋挞”的配套头像**。"))
        assertEquals(listOf("《新书》", "很重要！"), bold("推荐**《新书》**给你。这里**很重要！**要记住"))
        assertTrue(bold("一对**“尚未结束").isEmpty())
        assertTrue(bold("一对\\*\\*“原样”\\*\\*文字").isEmpty())
    }

    @Test fun codeAndLinkTargetsStayLiteral() {
        val raw = "一对**“原样”**文字"
        val url = "https://example.org/$raw"
        val doc = parser.parse("`$raw` [网页]($url)")
        assertEquals(raw, (doc.firstChild.firstChild as Code).literal)
        assertEquals(url, (doc.firstChild.lastChild as Link).destination)
        val linked = parser.parse("[$raw][]\n\n[$raw]: https://example.org")
        assertEquals("https://example.org", (linked.firstChild.firstChild as Link).destination)
    }
}
