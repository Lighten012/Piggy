"use strict";
const select = document.querySelector("#sheets"), grid = document.querySelector("#grid");
const prev = document.querySelector("#prev"), next = document.querySelector("#next");
const statusLine = document.querySelector("#status"), range = document.querySelector("#range");
let book, page = 0;
function cell(row, kind, value) {
  const td = document.createElement(kind);
  td.textContent = value;
  row.appendChild(td);
}
function draw() {
  const sheet = book.Sheets[select.value];
  grid.replaceChildren();
  const rect = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  // Keep each DOM page small even when the worksheet has many columns.
  const across = Math.ceil((rect.e.c - rect.s.c + 1) / 36);
  const left = rect.s.c + page % across * 36, top = rect.s.r + Math.floor(page / across) * 80;
  const right = Math.min(left + 35, rect.e.c), bottom = Math.min(top + 79, rect.e.r);
  const header = grid.createTHead().insertRow();
  cell(header, "th", "");
  for (let c=left; c<=right; c++) cell(header, "th", XLSX.utils.encode_col(c));
  const body = grid.createTBody();
  for (let r=top; r<=bottom; r++) {
    const row = body.insertRow();
    cell(row,"th",r+1);
    for (let c=left; c<=right; c++) {
      const data = sheet[XLSX.utils.encode_cell({r,c})];
      cell(row,"td", data ? (data.w ?? XLSX.utils.format_cell(data)) : "");
    }
  }
  prev.disabled = page===0;
  next.disabled = page+1 >= across*Math.ceil((rect.e.r-rect.s.r+1)/80);
  range.textContent = XLSX.utils.encode_range({s:{r:top,c:left},e:{r:bottom,c:right}});
  document.querySelector("main").scrollTo(0,0);
}
(async () => {
  try {
    const ext = location.search.slice(1);
    const bytes = await (await fetch("original")).arrayBuffer();
    if (ext==="csv" || ext==="tsv") {
      const data = new Uint8Array(bytes);
      let encoding = data[0]===255 && data[1]===254 ? "utf-16le" : data[0]===254 && data[1]===255 ? "utf-16be" : "utf-8";
      let text;
      try { text = new TextDecoder(encoding,{fatal:true}).decode(data); }
      catch { text = new TextDecoder("gb18030").decode(data); }
      book = XLSX.read(text,{type:"string",raw:true,FS:ext==="tsv"?"\t":","});
    } else book = XLSX.read(bytes,{type:"array",cellHTML:false,cellFormula:false,bookVBA:false});
    if (!book.SheetNames.length) throw Error();
    for (const name of book.SheetNames) select.add(new Option(name,name));
    select.onchange = () => {page=0;draw()};
    prev.onclick = () => {page--;draw()};
    next.onclick = () => {page++;draw()};
    draw(); statusLine.textContent="";
  } catch {
    statusLine.textContent="无法读取表格，文件可能已加密或损坏。";
    prev.disabled=next.disabled=true;
  }
})();
