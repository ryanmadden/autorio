// Incremental SGR parser for codex exec's colored, non-interactive output.
// Text is always rendered through textContent, never interpreted as HTML.
const palette = ["#1d2021", "#f2777a", "#99cc99", "#ffcc66", "#6699cc", "#cc99cc", "#66cccc", "#d3d0c8", "#747369", "#ff9999", "#bbdd99", "#ffee99", "#99bbff", "#e0b0ff", "#99eeee", "#ffffff"];
function color(n) {
  if (n < 16) return palette[n];
  if (n >= 232) return `rgb(${[8 + (n - 232) * 10].flatMap(v => [v, v, v]).join(",")})`;
  const v = n - 16, levels = [0, 95, 135, 175, 215, 255];
  return `rgb(${[levels[Math.floor(v / 36)], levels[Math.floor(v / 6) % 6], levels[v % 6]].join(",")})`;
}
export class CodexOutput {
  pending = "";
  style = {};
  push(chunk) {
    let input = this.pending + chunk, cursor = 0;
    this.pending = "";
    const segments = [];
    const emit = value => { if (value) segments.push({ text: value, style: { ...this.style } }); };
    while (cursor < input.length) {
      const escape = input.indexOf("\x1b", cursor);
      if (escape < 0) { emit(input.slice(cursor)); break; }
      emit(input.slice(cursor, escape));
      const rest = input.slice(escape);
      // OSC (window title etc.) and non-SGR CSI commands are not displayed.
      const match = rest.match(/^\x1b(?:\[([0-?]*)([ -/]*)([@-~])|\][\s\S]*?(?:\x07|\x1b\\)|[^\[\]])/);
      if (!match) { this.pending = rest.slice(0, 8192); break; }
      if (match[3] === "m") this.sgr(match[1]);
      cursor = escape + match[0].length;
    }
    return segments;
  }
  sgr(parameters) {
    const codes = parameters.split(";").map(n => Number(n || 0));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) this.style = {};
      else if (c === 1) this.style.fontWeight = "bold";
      else if (c === 2) this.style.opacity = "0.65";
      else if (c === 3) this.style.fontStyle = "italic";
      else if (c === 4) this.style.textDecoration = "underline";
      else if (c === 22) { delete this.style.fontWeight; delete this.style.opacity; }
      else if (c === 23) delete this.style.fontStyle;
      else if (c === 24) delete this.style.textDecoration;
      else if (c === 39) delete this.style.color;
      else if (c === 49) delete this.style.backgroundColor;
      else if (c >= 30 && c <= 37) this.style.color = color(c - 30);
      else if (c >= 90 && c <= 97) this.style.color = color(c - 90 + 8);
      else if (c >= 40 && c <= 47) this.style.backgroundColor = color(c - 40);
      else if (c >= 100 && c <= 107) this.style.backgroundColor = color(c - 100 + 8);
      else if (c === 38 || c === 48) {
        const property = c === 38 ? "color" : "backgroundColor";
        if (codes[i + 1] === 5 && Number.isInteger(codes[i + 2]) && codes[i + 2] >= 0 && codes[i + 2] < 256) {
          this.style[property] = color(codes[i + 2]); i += 2;
        } else if (codes[i + 1] === 2 && codes.slice(i + 2, i + 5).length === 3 && codes.slice(i + 2, i + 5).every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
          this.style[property] = `rgb(${codes.slice(i + 2, i + 5).join(",")})`; i += 4;
        }
      }
    }
  }
}
