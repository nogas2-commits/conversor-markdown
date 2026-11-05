// table-ocr: detecta tabelas em imagens (grade com linhas ou colunas alinhadas) e monta Markdown.
// Funciona no navegador (window.TableOCR) e no Node (require).
(function (root) {
  "use strict";

  // Escala sugerida para o OCR (texto pequeno de print melhora muito ampliado)
  function suggestScale(w, h) {
    w = Math.max(w, 1); h = Math.max(h, 1);
    let s = Math.min(3, Math.max(1, 3200 / w));      // ~3x em prints; texto pequeno melhora muito
    s = Math.min(s, Math.sqrt(6e6 / (w * h)));        // teto de ~6 megapixels (páginas inteiras)
    return Math.max(1, s);
  }

  // Analisa a imagem (ImageData-like {width,height,data}); apaga linhas de grade e pixels coloridos.
  // Retorna a grade encontrada (posições em px da imagem analisada).
  function analyze(img) {
    const { width: W, height: H, data } = img;
    const dark = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn > 35) { data[p] = data[p + 1] = data[p + 2] = 255; continue; } // marcas coloridas (ex.: triângulo verde do Excel)
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      dark[i] = gray < 205 ? 1 : 0; // linhas finas ficam cinza-claro depois de ampliadas
    }
    const unit = Math.max(1, W / 900); // ~1 em prints normais; cresce com a ampliação
    const minH = Math.round(Math.max(40 * unit, W * 0.06));
    const minV = Math.round(22 * unit);

    // linhas horizontais
    const hRows = [];
    const hRuns = [];
    for (let y = 0; y < H; y++) {
      let run = 0, total = 0; const runs = [];
      for (let x = 0; x <= W; x++) {
        if (x < W && dark[y * W + x]) run++;
        else { if (run >= minH) { total += run; runs.push([x - run, x]); } run = 0; }
      }
      if (total >= W * 0.2) { hRows.push(y); hRuns.push(runs); }
    }
    // linhas verticais
    const vCols = [];
    const vRuns = [];
    for (let x = 0; x < W; x++) {
      let run = 0, total = 0; const runs = [];
      for (let y = 0; y <= H; y++) {
        if (y < H && dark[y * W + x]) run++;
        else { if (run >= minV) { total += run; runs.push([y - run, y]); } run = 0; }
      }
      if (total >= minV) { vCols.push(x); vRuns.push(runs); }
    }
    const group = (arr) => { const out = []; for (const v of arr) { const g = out[out.length - 1]; if (g && v - g.end <= 2) g.end = v; else out.push({ start: v, end: v }); } return out.map(g => Math.round((g.start + g.end) / 2)); };
    let hs = group(hRows), vs = group(vCols);
    // verticais só contam dentro da área de uma tabela (evita apagar hastes de letras grandes)
    let top = 0, bot = 0;
    if (hs.length >= 2) {
      top = hs[0]; bot = hs[hs.length - 1];
      vs = vs.filter(x => coverV(x, top, bot) > (bot - top) * 0.15);
    } else vs = [];
    if (vs.length < 2) vs = [];

    // apaga as linhas (só os trechos longos) com 1px de folga
    const erase = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) { const p = (y * W + x) * 4; data[p] = data[p + 1] = data[p + 2] = 255; } };
    hRows.forEach((y, k) => hRuns[k].forEach(([a, b]) => { for (let x = a; x < b; x++) { erase(x, y - 1); erase(x, y); erase(x, y + 1); } }));
    if (vs.length) vCols.forEach((x, k) => {
      if (!vs.some(v => Math.abs(v - x) <= 3)) return;
      vRuns[k].forEach(([a, b]) => { for (let y = Math.max(a, top - 3); y < Math.min(b, bot + 3); y++) { erase(x - 1, y); erase(x, y); erase(x + 1, y); } });
    });
    function coverV(x, y0, y1) { let c = 0; for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) { let d = 0; for (let dx = -2; dx <= 2; dx++) if (x + dx >= 0 && x + dx < W && dark[y * W + x + dx]) d = 1; c += d; } return c; }
    function coverH(y, x0, x1) { let c = 0; for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) { let d = 0; for (let dy = -2; dy <= 2; dy++) if (y + dy >= 0 && y + dy < H && dark[(y + dy) * W + x]) d = 1; c += d; } return c; }
    // linha vertical cruza a faixa [y0,y1]? / horizontal cruza [x0,x1]?
    const vCross = (x, y0, y1) => coverV(x, y0 + 2, y1 - 2) >= (y1 - y0 - 4) * 0.6;
    const hCross = (y, x0, x1) => coverH(y, x0 + 2, x1 - 2) >= (x1 - x0 - 4) * 0.6;
    return { hs, vs, vCross, hCross, W, H, unit };
  }

  // Normaliza palavras do Tesseract (data.blocks) -> [{text,x0,y0,x1,y1,conf}]
  function wordsFrom(data) {
    const out = [];
    const push = w => { if (w && w.text && w.text.trim()) out.push({ text: w.text.trim(), x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, conf: w.confidence }); };
    if (data.words && data.words.length) data.words.forEach(push);
    else (data.blocks || []).forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => (l.words || []).forEach(push))));
    return out.filter(w => /^[-–—]$/.test(w.text) || (!(w.conf < 40 && /^[^\p{L}\p{N}]+$/u.test(w.text)) && !(w.conf < 20 && w.text.length <= 2)));
  }

  const cellText = ws => {
    ws.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
    const lines = [];
    for (const w of ws) { const L = lines[lines.length - 1]; const cy = (w.y0 + w.y1) / 2; if (L && cy < L.y1) L.ws.push(w), L.y1 = Math.max(L.y1, w.y1); else lines.push({ y1: w.y1, ws: [w] }); }
    return lines.map(L => L.ws.sort((a, b) => a.x0 - b.x0).map(w => w.text).join(" ")).join(" ").replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  };
  const esc = s => s.replace(/\|/g, "\\|");

  function mdTable(rows) {
    const n = Math.max(...rows.map(r => r.length));
    const line = r => "| " + Array.from({ length: n }, (_, i) => esc(r[i] || "")).join(" | ") + " |";
    return [line(rows[0]), "| " + Array(n).fill("---").join(" | ") + " |", ...rows.slice(1).map(line)].join("\n");
  }
  const linesText = ws => {
    ws = ws.slice().sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
    const lines = [];
    for (const w of ws) { const L = lines[lines.length - 1]; const cy = (w.y0 + w.y1) / 2; if (L && cy < L.y1) L.ws.push(w), L.y1 = Math.max(L.y1, w.y1); else lines.push({ y1: w.y1, ws: [w] }); }
    return lines.map(L => L.ws.sort((a, b) => a.x0 - b.x0).map(w => w.text).join(" ")).join("\n");
  };

  // Tabela com grade desenhada
  function gridToMd(words, g) {
    const { hs, vs } = g;
    if (hs.length < 2 || vs.length < 2) return null;
    const minRow = 8 * g.unit;
    const rowsB = []; for (let i = 0; i < hs.length - 1; i++) if (hs[i + 1] - hs[i] > minRow) rowsB.push([hs[i], hs[i + 1]]);
    const colsB = []; for (let i = 0; i < vs.length - 1; i++) if (vs[i + 1] - vs[i] > minRow) colsB.push([vs[i], vs[i + 1]]);
    if (rowsB.length < 2 || colsB.length < 2) return null;
    const top = rowsB[0][0], bot = rowsB[rowsB.length - 1][1], left = colsB[0][0], right = colsB[colsB.length - 1][1];
    const R = rowsB.length, C = colsB.length;
    const cells = Array.from({ length: R }, () => Array.from({ length: C }, () => []));
    const before = [], after = [];
    for (const w of words) {
      const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
      if (cy < top) { before.push(w); continue; }
      if (cy > bot) { after.push(w); continue; }
      if (cx < left || cx > right) { (cy < (top + bot) / 2 ? before : after).push(w); continue; }
      let r = rowsB.findIndex(([a, b]) => cy >= a && cy < b), c = colsB.findIndex(([a, b]) => cx >= a && cx < b);
      if (r < 0) r = R - 1; if (c < 0) c = C - 1;
      cells[r][c].push(w);
    }
    // mesclagens horizontais: a linha vertical entre c e c+1 não cruza a linha r
    const spanH = Array.from({ length: R }, () => Array(C).fill(false)); // spanH[r][c]: c mescla com c+1
    for (let r = 0; r < R; r++) for (let c = 0; c < C - 1; c++) spanH[r][c] = !g.vCross(colsB[c][1], rowsB[r][0], rowsB[r][1]);
    // célula numérica: descarta lixo curto de letras (marcas, bordas)
    for (const row of cells) for (let c = 0; c < row.length; c++) {
      const ws = row[c];
      if (ws.some(w => /\d/.test(w.text))) row[c] = ws.filter(w => !(/^\p{L}{1,2}$/u.test(w.text) && w.conf < 80));
    }
    let text = cells.map(row => row.map(cellText));
    // texto de célula mesclada que caiu na coluna da direita: puxa para o início do grupo
    for (let r = 0; r < R; r++) for (let c = 0; c < C - 1; c++) if (spanH[r][c]) {
      let s = c; while (s > 0 && spanH[r][s - 1]) s--;
      if (text[r][c + 1] && !text[r][s]) { text[r][s] = text[r][c + 1]; text[r][c + 1] = ""; }
      else if (text[r][c + 1] && s !== c + 1) { text[r][s] = (text[r][s] + " " + text[r][c + 1]).trim(); text[r][c + 1] = ""; }
    }
    // remove linhas e colunas totalmente vazias
    let keepR = text.map((row, r) => row.some(Boolean) ? r : -1).filter(r => r >= 0);
    const keepC = Array.from({ length: C }, (_, c) => c).filter(c => keepR.some(r => text[r][c]));
    if (keepR.length < 2 || keepC.length < 2) return null;
    // cabeçalho: inclui linhas seguintes enquanto a anterior tiver mesclagem horizontal
    let hdr = 1;
    while (hdr < keepR.length && spanH[keepR[hdr - 1]].some(Boolean)) hdr++;
    const header = keepC.map(c => {
      const parts = [];
      for (let k = 0; k < hdr; k++) {
        const r = keepR[k];
        let s = c; while (s > 0 && spanH[r][s - 1]) s--; // texto do início do grupo mesclado
        const t = text[r][s];
        if (t && parts[parts.length - 1] !== t) parts.push(t);
      }
      return parts.join(" ");
    });
    const body = keepR.slice(hdr).map(r => keepC.map(c => text[r][c]));
    fixNumbers(body);
    const out = [];
    const b = linesText(before); if (b.trim()) out.push(b);
    out.push(mdTable([header, ...body]));
    const a = linesText(after); if (a.trim()) out.push(a);
    return out.join("\n\n");
  }

  // Tabela sem grade: colunas pelos espaços em branco alinhados
  function alignedToMd(words) {
    if (words.length < 6) return null;
    const ws = words.slice().sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
    const hMed = median(ws.map(w => w.y1 - w.y0)) || 10;
    const lines = [];
    for (const w of ws) { const L = lines[lines.length - 1]; const cy = (w.y0 + w.y1) / 2; if (L && cy < L.y1 - hMed * 0.2) L.ws.push(w), L.y1 = Math.max(L.y1, w.y1); else lines.push({ y0: w.y0, y1: w.y1, ws: [w] }); }
    // segmentos por linha (gap > 1.2x altura da letra)
    for (const L of lines) {
      L.ws.sort((a, b) => a.x0 - b.x0);
      L.segs = [];
      for (const w of L.ws) { const s = L.segs[L.segs.length - 1]; if (s && w.x0 - s.x1 < hMed * 1.2) { s.ws.push(w); s.x1 = w.x1; } else L.segs.push({ x0: w.x0, x1: w.x1, ws: [w] }); }
    }
    // bloco de linhas consecutivas com >=2 segmentos
    let best = null;
    for (let i = 0; i < lines.length;) {
      if (lines[i].segs.length < 2) { i++; continue; }
      let j = i; while (j < lines.length && lines[j].segs.length >= 2) j++;
      if (j - i >= 3 && (!best || j - i > best[1] - best[0])) best = [i, j];
      i = j;
    }
    if (!best) return null;
    const tl = lines.slice(best[0], best[1]);
    // colunas: intervalos x cobertos por segmentos (união), separados por faixas vazias
    const iv = tl.flatMap(L => L.segs.map(s => [s.x0, s.x1])).sort((a, b) => a[0] - b[0]);
    const cols = [];
    for (const [a, b] of iv) { const c = cols[cols.length - 1]; if (c && a <= c[1] + hMed * 0.3) c[1] = Math.max(c[1], b); else cols.push([a, b]); }
    if (cols.length < 2) return null;
    const rows = tl.map(L => { const r = Array(cols.length).fill(""); for (const s of L.segs) { const cx = (s.x0 + s.x1) / 2; let k = cols.findIndex(([a, b]) => cx >= a && cx <= b); if (k < 0) k = 0; r[k] = (r[k] + " " + s.ws.map(w => w.text).join(" ")).trim(); } return r; });
    const out = [];
    const pre = lines.slice(0, best[0]).flatMap(L => L.ws), post = lines.slice(best[1]).flatMap(L => L.ws);
    if (pre.length) out.push(linesText(pre));
    out.push(mdTable(rows));
    if (post.length) out.push(linesText(post));
    return out.join("\n\n");
  }
  // coluna majoritariamente "n,nn": restaura vírgula perdida pelo OCR (521 -> 5,21)
  function fixNumbers(rows) {
    if (!rows.length) return;
    for (let c = 0; c < rows[0].length; c++) {
      const vals = rows.map(r => r[c] || "");
      // coluna de datas "jan/26": corrige separador lido errado ("julí26" -> "jul/26")
      const mm = vals.filter(v => /^\p{L}{3}\/\d{2,4}$/u.test(v)).length;
      if (mm >= Math.max(2, vals.filter(Boolean).length * 0.6)) {
        rows.forEach(r => { if (r[c]) r[c] = r[c].replace(/^(\p{L}{3})[^\p{N}\/\s]?[\/|\\íìil1]?(\d{2,4})$/u, "$1/$2"); });
        continue;
      }
      // coluna de inteiros com milhar "1.234": "14,265" -> "14.265"
      const filled = vals.filter(v => /\d/.test(v));
      const thou = filled.filter(v => /^\d{1,3}(\.\d{3})+$/.test(v)).length;
      const dec2 = filled.filter(v => /,\d{1,2}$/.test(v)).length;
      if (thou >= Math.max(2, filled.length * 0.4) && dec2 === 0) {
        rows.forEach(r => { if (r[c]) r[c] = r[c].replace(/^(\d{1,3}),(\d{3})$/, "$1.$2"); });
        continue;
      }
      const m = vals.map(v => v.match(/^-?[\d.]*\d,(\d+)$/)).filter(Boolean);
      if (m.length < Math.max(2, vals.filter(Boolean).length * 0.6)) continue;
      const dec = m[0][1].length;
      if (!m.every(x => x[1].length === dec)) continue;
      const rx = new RegExp("^(\\d+)\\.(\\d{" + dec + "})$");
      rows.forEach(r => {
        const v = r[c] || "";
        if (/^\d+$/.test(v) && v.length > dec) r[c] = v.slice(0, -dec) + "," + v.slice(-dec);
        else if (rx.test(v)) r[c] = v.replace(rx, "$1,$2"); // 0.24 -> 0,24
      });
    }
  }
  function median(a) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

  const api = { suggestScale, analyze, wordsFrom, gridToMd, alignedToMd };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TableOCR = api;
})(typeof self !== "undefined" ? self : this);
