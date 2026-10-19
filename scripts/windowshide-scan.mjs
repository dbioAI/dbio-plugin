// #1110 — quét mã: mọi lệnh sinh tiến trình (child_process) PHẢI có windowsHide, nếu không Windows bật cửa sổ cmd lên màn hình chủ.
// scan(src) → [{ line, fn, start, end, text }] các lời gọi thiếu windowsHide (end = vị trí dấu ')' đóng). fix(src) → mã đã chèn windowsHide.
const FNS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

// Vị trí ')' khớp với '(' tại i (bỏ qua chuỗi, template, chú thích). -1 nếu không khớp.
function closeParen(s, i) {
  let d = 0;
  for (let p = i; p < s.length; p++) {
    const c = s[p];
    if (c === '/' && s[p + 1] === '/') { while (p < s.length && s[p] !== '\n') p++; continue; }
    if (c === '/' && s[p + 1] === '*') { p = s.indexOf('*/', p + 2); if (p < 0) return -1; p++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (p++; p < s.length && s[p] !== c; p++) { if (s[p] === '\\') p++; else if (c === '`' && s[p] === '$' && s[p + 1] === '{') { const e = closeBrace(s, p + 1); if (e < 0) return -1; p = e; } }
      continue;
    }
    if (c === '(') d++; else if (c === ')' && --d === 0) return p;
  }
  return -1;
}
function closeBrace(s, i) {
  let d = 0;
  for (let p = i; p < s.length; p++) {
    const c = s[p];
    if (c === '"' || c === "'") { for (p++; p < s.length && s[p] !== c; p++) if (s[p] === '\\') p++; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return p;
  }
  return -1;
}

export function scan(src) {
  if (!/child_process/.test(src)) return [];
  const out = [];
  const re = /(?<![.\w$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g;
  for (let m; (m = re.exec(src));) {
    if (!FNS.has(m[1])) continue;
    const open = m.index + m[0].length - 1;
    const end = closeParen(src, open);
    if (end < 0) continue;
    const text = src.slice(open, end + 1);
    if (/windowsHide/.test(text)) continue;
    out.push({ line: src.slice(0, m.index).split('\n').length, fn: m[1], start: open, end, text });
  }
  return out;
}

// Chèn tự động: đối số cuối là `{…}` ⇒ thêm `windowsHide: true` đầu; không có tuỳ chọn ⇒ thêm `{ windowsHide: true }`. Trả { src, manual } (manual = lời gọi cần sửa tay: callback/biến).
export function fix(src) {
  const bad = scan(src).sort((a, b) => b.start - a.start); let manual = [];
  for (const b of bad) {
    const inner = src.slice(b.start + 1, b.end).trimEnd();
    // đối số cuối cấp cao nhất
    let depth = 0, last = 0, q = null;
    for (let p = 0; p < inner.length; p++) {
      const c = inner[p];
      if (q) { if (c === '\\') p++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') q = c;
      else if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
      else if (c === ',' && depth === 0) last = p + 1;
    }
    const lastArg = inner.slice(last).trim();
    if (/=>|^function\b/.test(lastArg) && !lastArg.startsWith('{')) { manual.push(b); continue; }
    if (lastArg.startsWith('{') && lastArg.endsWith('}')) {
      const bracePos = b.start + 1 + last + inner.slice(last).indexOf('{');
      const body = lastArg.slice(1).trimStart();
      src = src.slice(0, bracePos + 1) + ' windowsHide: true' + (body.startsWith('}') ? ' ' : ',') + src.slice(bracePos + 1);
    } else if (/^[\w$.]+$/.test(lastArg) && b.fn !== 'fork' && inner.split(',').length >= 3 && !/^\[/.test(lastArg)) { manual.push(b); }
    else { src = src.slice(0, b.start + 1 + inner.length) + ', { windowsHide: true }' + src.slice(b.start + 1 + inner.length); }
  }
  return { src, manual };
}
