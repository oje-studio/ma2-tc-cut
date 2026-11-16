// Read XML without serializing it: edits use source spans, so unrelated bytes survive.
export interface XmlAttribute { value: string; start: number; end: number }
export interface XmlNode {
  tag: string;
  start: number;
  openEnd: number;
  end: number;
  attrs: Map<string, XmlAttribute>;
  children: XmlNode[];
  parent?: XmlNode;
}
export interface Patch { start: number; end: number; value: string }

function unescape(value: string): string {
  return value.replace(/&([^;]*);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity in named) return named[entity];
    if (/^#(?:\d+|x[\da-f]+)$/i.test(entity)) {
      const n = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (n > 0 && n <= 0x10ffff) return String.fromCodePoint(n);
    }
    throw new Error('Unsupported XML entity. Export the timecode show directly from grandMA3.');
  });
}

export function readXml(text: string): XmlNode[] {
  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (pos < text.length) {
    const start = text.indexOf('<', pos);
    const plain = text.slice(pos, start < 0 ? text.length : start);
    if (!stack.length && plain.trim()) throw new Error('Text outside the XML root.');
    if (start < 0) break;
    const skip = text.startsWith('<!--', start) ? ['-->', 4] as const
      : text.startsWith('<?', start) ? ['?>', 2] as const
      : text.startsWith('<![CDATA[', start) ? [']]>', 9] as const : null;
    if (skip) {
      const end = text.indexOf(skip[0], start + skip[1]);
      if (end < 0) throw new Error('Unclosed XML comment or declaration.');
      pos = end + skip[0].length;
      continue;
    }
    if (text.startsWith('<!', start)) throw new Error('XML document types are not supported.');
    let end = start + 1;
    let quote = '';
    for (; end < text.length; end++) {
      const c = text[end];
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (end === text.length) throw new Error('Unclosed XML tag.');
    const raw = text.slice(start, end + 1);
    if (raw.startsWith('</')) {
      const m = /^<\/([\w:.-]+)\s*>$/.exec(raw);
      const node = stack.pop();
      if (!node || m?.[1] !== node.tag) throw new Error('Mismatched XML closing tag.');
      node.end = end + 1;
    } else {
      const m = /^<([\w:.-]+)/.exec(raw);
      if (!m) throw new Error('Invalid XML tag.');
      const selfClosing = /\/\s*>$/.test(raw);
      const attrEnd = raw.length - (selfClosing ? raw.match(/\/\s*>$/)![0].length : 1);
      const attrText = raw.slice(m[0].length, attrEnd);
      const attrs = new Map<string, XmlAttribute>();
      const re = /\s+([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/gy;
      let at = 0;
      while (at < attrText.length && attrText.slice(at).trim()) {
        re.lastIndex = at;
        const a = re.exec(attrText);
        if (!a || attrs.has(a[1])) throw new Error('Invalid or duplicate XML attribute.');
        const valueStart = start + m[0].length + a.index + a[0].indexOf(a[2]) + 1;
        attrs.set(a[1], { value: unescape(a[3]), start: valueStart, end: valueStart + a[3].length });
        at = re.lastIndex;
      }
      const parent = stack.at(-1);
      const node: XmlNode = { tag: m[1], start, openEnd: end + 1, end: end + 1, attrs, children: [], parent };
      (parent ? parent.children : roots).push(node);
      if (!selfClosing) stack.push(node);
    }
    pos = end + 1;
  }
  if (stack.length || roots.length !== 1) throw new Error('Expected one complete XML document.');
  return roots;
}

export function attr(node: XmlNode, key: string): string | undefined { return node.attrs.get(key)?.value; }

export function setAttr(node: XmlNode, key: string, value: string, patches: Patch[]): void {
  const a = node.attrs.get(key);
  if (!a) throw new Error(`Missing ${node.tag}.${key}.`);
  if (a.value !== value) patches.push({ start: a.start, end: a.end, value });
}

export function patchXml(text: string, patches: Patch[]): string {
  const sorted = patches.sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let end = 0;
  for (const p of sorted) {
    if (p.start < end) throw new Error('Overlapping XML edits.');
    out.push(text.slice(end, p.start), p.value);
    end = p.end;
  }
  out.push(text.slice(end));
  return out.join('');
}
