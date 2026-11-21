type Annotation = {type:string; url?:string; start_index?:number; end_index?:number};
type Part = {type:string; text?:string; refusal?:string; annotations?:Annotation[]};
type Item = {type:string; id?:string; status?:string; content?:Part[]};

function cite(part: Part) {
  const text = part.text ?? part.refusal ?? "";
  const annotations = part.annotations?.filter(a => a.type === "url_citation" && typeof a.url === "string");
  if (!annotations?.length) return text;
  // Provider offsets count Unicode characters. Keep the original prose when a span cites a claim.
  const chars = Array.from(text);
  const insertions = new Map<number,Set<string>>();
  const markers = new Set<number>();
  for (const annotation of annotations) {
    let url: URL;
    try { url = new URL(annotation.url!); } catch { continue; }
    if (!["https:","http:"].includes(url.protocol) || url.username || url.password) continue;
    const start = annotation.start_index, end = annotation.end_index;
    const valid = Number.isInteger(start) && Number.isInteger(end) && start! >= 0 && end! >= start! && end! <= chars.length;
    const position = valid ? end! : chars.length;
    const span = valid ? chars.slice(start,end).join("") : text;
    // OpenAI often supplies the same clickable Markdown link inline already.
    if (span.includes("]("+annotation.url+")") || span.includes("](<"+annotation.url+">)")) continue;
    if (valid && /^\uE200cite[^\uE201]*\uE201$/u.test(span)) {
      for (let i = start!; i < end!; i++) markers.add(i);
    }
    const href = url.href.replace(/[()<>\\]/g,c=>"%"+c.charCodeAt(0).toString(16));
    const links = insertions.get(position) ?? new Set();
    links.add("[来源 · "+url.hostname+"]("+href+")");
    insertions.set(position,links);
  }
  for (const i of markers) chars[i] = "";
  // Insert in reverse order so later offsets remain valid.
  for (const [position,links] of [...insertions].sort(([a],[b])=>b-a)) {
    chars.splice(position,0," "+[...links].join(" "));
  }
  return chars.join("");
}

export class WebSearch {
  private cited = new Map<string,string>();
  used = false;

  observe(raw: unknown) {
    const event = raw as {type:string; item?:Item; response?:{output?:Item[]}};
    const items = event.type === "response.output_item.done" && event.item ? [event.item]
      : event.type === "response.completed" ? event.response?.output ?? [] : [];
    for (const item of items) {
      if (item.type === "web_search_call" && item.id && item.status === "completed") this.used = true;
      if (item.type !== "message" || !item.content?.some(p => p.annotations?.some(a=>a.type==="url_citation"))) continue;
      const original = item.content.map(p => p.text ?? p.refusal ?? "").join("");
      this.cited.set(original,item.content.map(cite).join(""));
    }
  }

  render(text: string) { return this.cited.get(text) ?? text; }
}
