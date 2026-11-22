package dev.pichat

// Offsets use UTF-16, as do Kotlin strings and the server's JavaScript strings.
internal fun replyPositions(answer: String, offsets: List<Int>): List<Int> {
    if (offsets.all { it < 0 } && offsets.isNotEmpty()) {
        // Older releases retained the captions and delivery order, but no link offsets.
        val lines = Regex("""(?m)^\S[^\r\n]*""").findAll(answer).toList()
        val ordinals = listOf("一", "二", "三", "四", "五", "六", "七", "八", "九", "十")
        if (lines.size == offsets.size && lines.size <= ordinals.size && lines.withIndex().all { (i, line) ->
                Regex("^第(?:${ordinals[i]}|${i+1})(?:张|份|个)").containsMatchIn(line.value)
            }) return lines.map { it.range.last + 1 }
    }
    return offsets.map { if (it in 0..answer.length) it else answer.length }
}
