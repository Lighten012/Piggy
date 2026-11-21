const segmenter = new Intl.Segmenter("zh", {granularity:"word"});
const stopWords = new Set("我 你 他 她 它 我们 你们 的 了 呀 啊 吗 呢 这 那 是 什么 哪个 一下 a an the is are i my me you your".split(" "));
const normalize = (text:string) => text.normalize("NFKC").toLowerCase().trim();

function addWords(terms:Set<string>, text:string) {
  for (const {segment,isWordLike} of segmenter.segment(text)) {
    if (isWordLike && !stopWords.has(segment)) terms.add(segment);
  }
}

function usefulPhrase(term:string) {
  return term.length <= 100 && /[\p{L}\p{N}]/u.test(term) && !stopWords.has(term);
}

export function memoryKeywords(content:string, hints:readonly string[] = []) {
  const text = normalize(content);
  const terms = new Set<string>();
  for (const hint of hints) {
    const term = normalize(hint);
    if (usefulPhrase(term) && text.includes(term)) terms.add(term);
  }
  addWords(terms,text);
  return [...terms];
}

export function queryKeywords(keywords:readonly string[]) {
  const terms = new Set<string>();
  for (const keyword of keywords) {
    const term = normalize(keyword);
    if (usefulPhrase(term)) {
      terms.add(term);
      addWords(terms,term);
    }
  }
  return [...terms];
}
