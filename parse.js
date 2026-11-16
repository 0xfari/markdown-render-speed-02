// parse.js — a fast CommonMark 0.31.2 + GFM 0.29 parser, byte-compatible with
// marked 18.1.3 (default options, GFM on). Written from scratch in this session
// against the CommonMark and GFM specs and the kit's practice set; marked itself
// is only ever used as a black-box oracle (never read or copied) to settle
// edge cases. Dependency-free ES module: parse(markdown) returns the HTML
// marked.parse(markdown) returns, for every input.

/* ---------------- utilities ---------------- */

/**
 * marked's URL encoding: encodeURI, except that '%' is never encoded — a
 * bare '%' stays '%', and an already-encoded '%20' stays '%20' (encodeURI
 * would turn it into '%2520'). Undoing encodeURI's % -> %25 step restores
 * every original '%' exactly.
 */
function encodeHref(u) {
  return encodeURI(u).replace(/%25/g, '%');
}

/** Escape &, <, >, " and ' in text (marked escapes ' as &#39;). Fast path when nothing needs escaping. */
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (start < i) out += s.slice(start, i);
      out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

/** Escape &, <, >, ", ' for attribute values (marked uses one escape fn). */
/**
 * Escape for attribute values (href, title, alt). Like esc() but a
 * `&` that starts a valid entity reference (&word; or &#...;) is left
 * untouched — marked keeps entities raw in attributes.
 */
function escAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const e = scanEntity(s, i);
      if (e) {
        if (start < i) out += s.slice(start, i);
        out += e.text;
        start = e.end;
        i = e.end - 1;
        continue;
      }
      if (start < i) out += s.slice(start, i);
      out += '&amp;';
      start = i + 1;
    } else if (c === 60 || c === 62 || c === 34 || c === 39) {
      if (start < i) out += s.slice(start, i);
      out += c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}
function isDigit(c) {
  return c >= 48 && c <= 57;
}
function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnum(c) {
  return isAlpha(c) || isDigit(c);
}
/** ASCII punctuation (CommonMark's set). */
function isPunct(c) {
  return (
    (c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126)
  );
}
function isWhitespaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/* ---------------- entities ---------------- */

/**
 * Scan an entity reference at s[i] === '&'.
 * Marked's model: a numeric entity (&#123; / &#x1F;) decodes to its
 * character (0, surrogates and >0x10FFFF become U+FFFD); a named
 * entity-like &word; is kept VERBATIM (marked never decodes named
 * entities — the browser does). Returns {kind, ch, text, end} or null.
 * `text` is the raw reference (e.g. "&copy;"), `ch` the decoded char for
 * numeric entities.
 */
function scanEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) {
    // numeric: &#123; or &#x1F; / &#X1F;
    let j = i + 2;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    let cp = 0;
    let digits = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
              : (c >= 48 && c <= 57)) {
        cp = cp * (hex ? 16 : 10) + (c <= 57 ? c - 48 : (c | 32) - 87);
        j++;
        digits++;
        if (cp > 0x10FFFF) break;
      } else break;
    }
    if (digits === 0 || j >= n || s.charCodeAt(j) !== 59) return null;
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return { kind: 'numeric', ch: String.fromCodePoint(cp), text: s.slice(i, j + 1), end: j + 1 };
  }
  if (!isAlpha(c1)) return null;
  let j = i + 1;
  while (j < n && isAlnum(s.charCodeAt(j))) j++;
  if (j >= n || s.charCodeAt(j) !== 59) return null;
  if (j - i - 1 > 31) return null;
  return { kind: 'named', ch: null, text: s.slice(i, j + 1), end: j + 1 };
}

/** Normalize a link label: trim, collapse whitespace to single spaces, lowercase. */
function normalizeLabel(s) {
  let out = '';
  let start = 0;
  let pendingSpace = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) {
      if (start < i) { if (pendingSpace) out += ' '; out += s.slice(start, i); pendingSpace = false; }
      pendingSpace = out.length > 0;
      start = i + 1;
    }
  }
  if (start < s.length) { if (pendingSpace) out += ' '; out += s.slice(start); }
  // CommonMark matches labels by Unicode case folding, not lowercasing:
  // ß and ẞ both fold to "ss", and the Latin ligatures expand (ﬀ→ff,
  // ﬁ→fi, ﬂ→fl, ﬃ→ffi, ﬄ→ffl, ﬅ→st, ﬆ→st). toLowerCase() alone gives ß.
  return out.toLowerCase()
    .replace(/\u00df|\u1e9e/g, 'ss')
    .replace(/\ufb00/g, 'ff').replace(/\ufb01/g, 'fi').replace(/\ufb02/g, 'fl')
    .replace(/\ufb03/g, 'ffi').replace(/\ufb04/g, 'ffl')
    .replace(/\ufb05|\ufb06/g, 'st');
}

/* ---------------- inline parsing ---------------- */

// Inline node kinds (flat doubly-linked list):
//  text {s}  code {s}  html {s}  br  soft
//  delim {ch:'*'|'_'|'~'|'['|'!', n, canOpen, canClose, src}
//  linkO {href, title}  linkC  img {href, title, alt}  auto {href, text}
//  emO emC stO stC delO delC  (markers inserted by emphasis processing)

function newNode(t) {
  return { t, s: '', next: null, prev: null };
}

function isUniSpace(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
    c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF
  );
}
/**
 * CommonMark "Unicode punctuation": ASCII punctuation or anything in
 * Unicode general categories P (punctuation) or S (symbol). The ranges
 * below cover the P/S blocks (Latin-1 symbols like £, currency like €,
 * letterlike/math/technical symbols, general + supplemental punctuation,
 * CJK symbols, fullwidth forms).
 */
function isUniPunct(c) {
  if (isPunct(c)) return true;
  return (
    (c >= 0x00A1 && c <= 0x00BF) || (c >= 0x00D7 && c <= 0x00D7) || (c >= 0x00F7 && c <= 0x00F7) ||
    (c >= 0x2000 && c <= 0x206F) || (c >= 0x20A0 && c <= 0x20BF) ||
    (c >= 0x2100 && c <= 0x214F) || (c >= 0x2200 && c <= 0x22FF) ||
    (c >= 0x2300 && c <= 0x23FF) || (c >= 0x2E00 && c <= 0x2E7F) ||
    (c >= 0x3001 && c <= 0x303F) || (c >= 0xFF01 && c <= 0xFF0F) ||
    (c >= 0xFF1A && c <= 0xFF20) || (c >= 0xFF3B && c <= 0xFF40) ||
    (c >= 0xFF5B && c <= 0xFF65)
  );
}

/** Flanking info for a delimiter run at s[i..i+n): returns [canOpen, canClose] for * (same for ~). */
function flanking(s, i, n) {
  const before = i > 0 ? s.charCodeAt(i - 1) : -1;
  const after = i + n < s.length ? s.charCodeAt(i + n) : -1;
  const beforeSpace = before < 0 || isUniSpace(before);
  const afterSpace = after < 0 || isUniSpace(after);
  const beforePunct = before >= 0 && isUniPunct(before);
  const afterPunct = after >= 0 && isUniPunct(after);
  const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  return [leftFlanking, rightFlanking];
}

/** Parse a link destination starting at s[i] (just past '(' or after '[' label). Returns {dest, end} or null. */
function parseLinkDestination(s, i) {
  const n = s.length;
  // skip whitespace (but not across a blank line)
  let j = i;
  let newlines = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9) j++;
    else if (c === 10) { newlines++; if (newlines > 1) return null; j++; }
    else break;
  }
  if (j >= n) return null;
  let dest = '';
  if (s.charCodeAt(j) === 60) {
    // <...> (a backslash-escaped char, e.g. \>, does not close it)
    j++;
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 10) return null;
      if (c === 92 && j + 1 < n) { j += 2; continue; }
      if (c === 62) {
        dest = s.slice(start, j);
        // resolve backslash escapes inside <>
        if (dest.indexOf('\\') >= 0) {
          let d2 = '';
          for (let k = 0; k < dest.length; k++) {
            if (dest.charCodeAt(k) === 92 && k + 1 < dest.length && isPunct(dest.charCodeAt(k + 1))) { d2 += dest[k + 1]; k++; }
            else d2 += dest[k];
          }
          dest = d2;
        }
        return { dest, end: j + 1 };
      }
      if (c === 60) return null;
      j++;
    }
    return null;
  }
  // bare destination: no spaces/control, balanced parens
  let depth = 0;
  let start = j;
  let out = '';
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c < 32 || c === 127) break;
    if (c === 92 && j + 1 < n && isPunct(s.charCodeAt(j + 1))) { out += s.slice(start, j); out += s[j + 1]; j += 2; start = j; }
    else if (c === 40) { depth++; j++; }
    else if (c === 41) {
      if (depth === 0) break;
      depth--; j++;
    } else j++;
  }
  if (j === start && out === '') return null;
  if (out === '') dest = s.slice(start, j);
  else { out += s.slice(start, j); dest = out; }
  return { dest, end: j };
}

/** Parse a link title starting at s[i] (after destination + whitespace). Returns {title, end} or null. */
function parseLinkTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s.charCodeAt(i);
  let close;
  if (q === 34 || q === 39) close = q;
  else if (q === 40) close = 41;
  else return null;
  let j = i + 1;
  let out = '';
  let start = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === close) {
      out += s.slice(start, j);
      return { title: out, end: j + 1 };
    }
    if (c === 10) {
      // title may span a single line ending, not a blank line
      if (j + 1 < n && s.charCodeAt(j + 1) === 10) return null;
      out += s.slice(start, j + 1);
      start = j + 1;
      j++;
      continue;
    }
    if (c === 92 && j + 1 < n && isPunct(s.charCodeAt(j + 1))) {
      out += s.slice(start, j) + s[j + 1];
      j += 2;
      start = j;
      continue;
    }
    if (q === 40 && c === 40) return null; // unescaped ( inside (...) title
    j++;
  }
  return null;
}

/** Skip whitespace (space/tab/newline) from i; fail (null) if it crosses a blank line. */
function skipLinkSpace(s, i) {
  const n = s.length;
  let j = i;
  let newlines = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9) j++;
    else if (c === 10) { newlines++; if (newlines > 1) return -1; j++; }
    else break;
  }
  return j;
}

/**
 * Try to parse an inline link "(dest \"title\")" starting at s[i] === '('.
 * Returns {href, title, end} (end just past ')') or null.
 */
function parseInlineLink(s, i) {
  const n = s.length;
  if (i >= n || s.charCodeAt(i) !== 40) return null;
  let d = parseLinkDestination(s, i + 1);
  let j;
  if (!d) {
    // empty destination: [link]() is a valid inline link with href=""
    let k = i + 1;
    let nl = 0;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 32 || c === 9) k++;
      else if (c === 10) { nl++; if (nl > 1) return null; k++; }
      else break;
    }
    if (k >= n || s.charCodeAt(k) !== 41) return null;
    d = { dest: '', end: k };
  }
  j = d.end;
  let title = null;
  const after = skipLinkSpace(s, j);
  if (after < 0) return null;
  j = after;
  if (j < n && s.charCodeAt(j) !== 41) {
    const t = parseLinkTitle(s, j);
    if (!t) return null;
    title = t.title;
    const after2 = skipLinkSpace(s, t.end);
    if (after2 < 0) return null;
    j = after2;
  }
  if (j >= n || s.charCodeAt(j) !== 41) return null;
  return { href: d.dest, title, end: j + 1 };
}

/**
 * Parse a link label starting at s[i] === '[' (with bracket nesting).
 * Returns {label, end} (end just past ']') or null. Label max 999 chars.
 */
function parseLabel(s, i) {
  // a link label ends at the first unescaped `]` and may not contain an
  // unescaped `[` (nested brackets belong in link TEXT, not in labels:
  // `[foo][ref[bar]]` forms no link). Escaped \[ does not count.
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j += 2; continue; }
    if (c === 91) return null;
    if (c === 93) {
      const label = s.slice(i + 1, j);
      if (label.length === 0 || label.length > 999) return null;
      return { label, end: j + 1 };
    }
    j++;
    if (j - i > 1001) return null;
  }
  return null;
}

/** Check whether s[i..] starts a valid HTML tag/comment/PI/declaration/CDATA. Returns end index or -1. */
function scanHtmlTag(s, i) {
  const n = s.length;
  if (i + 1 >= n || s.charCodeAt(i) !== 60) return -1;
  let j = i + 1;
  const c = s.charCodeAt(j);
  if (c === 33) {
    // <!-- --> or <![CDATA[ ]]> or <!A >  (j points at `!`, so the comment
    // open is `!--` from j, not `<!--`)
    if (s.startsWith('!--', j)) {
      // abrupt closings: `<!-->` and `<!--->` are complete empty comments
      // (a later `-->` is then plain text, not part of this comment)
      if (s.charCodeAt(j + 3) === 62) return j + 4;
      if (s.charCodeAt(j + 3) === 45 && s.charCodeAt(j + 4) === 62) return j + 5;
      const end = s.indexOf('-->', j + 3);
      return end < 0 ? -1 : end + 3;
    }
    if (s.startsWith('[CDATA[', j + 1)) {
      const end = s.indexOf(']]>', j + 7);
      return end < 0 ? -1 : end + 3;
    }
    // <!A...>: letter then anything until >
    if (j + 1 < n && isAlpha(s.charCodeAt(j + 1))) {
      const end = s.indexOf('>', j + 1);
      return end < 0 ? -1 : end + 1;
    }
    return -1;
  }
  if (c === 63) {
    const end = s.indexOf('?>', j + 1);
    return end < 0 ? -1 : end + 2;
  }
  // open or close tag
  let k = j;
  const isClose = s.charCodeAt(k) === 47;
  if (isClose) k++;
  if (k >= n || !isAlpha(s.charCodeAt(k))) return -1;
  while (k < n && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 45)) k++;
  // the tag name must be followed by whitespace, `/`, or `>` — a `:` (or
  // other attribute char) directly after the name is not a tag (cm-609:
  // `<m:abc>` is escaped text, not raw HTML)
  if (k < n) {
    const nc = s.charCodeAt(k);
    if (nc !== 32 && nc !== 9 && nc !== 10 && nc !== 13 && nc !== 47 && nc !== 62) return -1;
  }
  // a close tag takes NO attributes — only whitespace, then `>`
  // (cm-624: `</a href="foo">` is escaped text, not raw HTML)
  if (isClose) {
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10 || s.charCodeAt(k) === 13)) k++;
    if (k < n && s.charCodeAt(k) === 62) return k + 1;
    return -1;
  }
  // attributes
  while (k < n) {
    const ch = s.charCodeAt(k);
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) { k++; continue; }
    if (ch === 47) {
      if (k + 1 < n && s.charCodeAt(k + 1) === 62) return k + 2;
      return -1;
    }
    if (ch === 62) return k + 1;
    // attribute name
    if (!(isAlpha(ch) || ch === 95 || ch === 58 || isDigit(ch) || ch === 45 || ch === 46)) return -1;
    while (k < n) {
      const a = s.charCodeAt(k);
      if (isAlnum(a) || a === 95 || a === 58 || a === 45 || a === 46) k++;
      else break;
    }
    // optional =value
    let m = k;
    while (m < n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9 || s.charCodeAt(m) === 10)) m++;
    if (m < n && s.charCodeAt(m) === 61) {
      m++;
      while (m < n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9 || s.charCodeAt(m) === 10)) m++;
      if (m >= n) return -1;
      const q = s.charCodeAt(m);
      if (q === 34 || q === 39) {
        const end = s.indexOf(String.fromCharCode(q), m + 1);
        if (end < 0) return -1;
        k = end + 1;
        // attributes must be separated by whitespace: a letter directly
        // after the closing quote is not a new attribute (cm-622:
        // `<a href='bar'title=title>` is escaped, not a tag)
        if (k < n) {
          const nx = s.charCodeAt(k);
          if (isAlpha(nx) || nx === 95 || nx === 58 || isDigit(nx) || nx === 45 || nx === 46) return -1;
        }
      } else {
        // unquoted value: no space, ", ', =, <, >, ` (scan from `m`, where
        // the value begins — `k` still points at the `=` before it)
        k = m;
        while (k < n) {
          const v = s.charCodeAt(k);
          if (v === 32 || v === 9 || v === 10 || v === 34 || v === 39 || v === 61 || v === 60 || v === 62 || v === 96) break;
          k++;
        }
        if (k === m) return -1;
      }
    } else {
      k = m;
    }
  }
  return -1;
}

/** Try `<scheme:...>` or `<email>` autolink at s[i] === '<'. Returns {href, text, end} or null. */
function scanAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  // scheme: 2-32 chars, first alpha, then alnum + - .
  if (j < n && isAlpha(s.charCodeAt(j))) {
    let k = j + 1;
    while (k < n && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 43 || s.charCodeAt(k) === 45 || s.charCodeAt(k) === 46)) k++;
    if (k - j >= 2 && k - j <= 32 && k < n && s.charCodeAt(k) === 58) {
      // rest until > with no space/control/<
      let m = k + 1;
      while (m < n) {
        const c = s.charCodeAt(m);
        if (c === 62) {
          if (m === k + 1) return null;
          const text = s.slice(i + 1, m);
          return { href: encodeHref(text), text, end: m + 1 };
        }
        if (c === 32 || c === 60 || c < 32) return null;
        m++;
      }
      return null;
    }
  }
  // email: local@domain
  let k = j;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
        c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 || c === 96 ||
        c === 123 || c === 124 || c === 125 || c === 126 || c === 45) k++;
    else break;
  }
  if (k > j && k < n && s.charCodeAt(k) === 64) {
    let m = k + 1;
    let lastDot = -1;
    let labels = 0;
    while (m < n) {
      const c = s.charCodeAt(m);
      if (isAlnum(c) || c === 45) { m++; continue; }
      if (c === 46) {
        if (m === k + 1 || m + 1 >= n || !isAlnum(s.charCodeAt(m + 1))) return null;
        lastDot = m;
        labels++;
        m++;
        continue;
      }
      break;
    }
    if (m > k + 1 && lastDot > 0 && s.charCodeAt(m) === 62 && m - lastDot > 1) {
      const text = s.slice(i + 1, m);
      return { href: 'mailto:' + encodeHref(text), text, end: m + 1 };
    }
  }
  return null;
}

/** Domain label chars for extended autolinks. */
function isDomainChar(c) {
  return isAlnum(c) || c === 45 || c === 95;
}

/**
 * Try a GFM extended autolink at s[i]. `prevCh` is the char code before i
 * (-1 at the start). Returns {href, text, end} or null. `text` is the
 * displayed URL (without mailto:). Marked's rules: a scheme:// autolink
 * has NO preceding-char restriction, while www. requires the preceding
 * char NOT to be alphanumeric.
 */
function scanExtendedAutolink(s, i, prevCh) {
  const n = s.length;
  // www. domain — preceding char must not be alphanumeric
  if (s.startsWith('www.', i)) {
    if (prevCh >= 0 && isAlnum(prevCh)) return null;
    const r = scanGfmDomain(s, i, true);
    if (r) return r;
    return null;
  }
  // scheme:// — scheme of 2-32 chars, no preceding-char restriction
  if (isAlpha(s.charCodeAt(i))) {
    let k = i + 1;
    while (k < n && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 43 || s.charCodeAt(k) === 45 || s.charCodeAt(k) === 46)) k++;
    if (k - i >= 2 && k - i <= 32 && s.startsWith('://', k)) {
      const r = scanGfmDomain(s, i, false);
      if (r) return r;
    }
    // scheme: (no //) — e.g. mailto:foo@bar.baz, xmpp:foo@bar.baz: the
    // part after ':' is any run of non-space, non-control characters
    if (k - i >= 2 && k - i <= 32 && k < n && s.charCodeAt(k) === 58) {
      const r = scanSchemeUri(s, i, k + 1);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Scan a scheme: URI (no //) starting at s[i], with the part after ':'
 * beginning at `start`. Returns {href, text, end} or null.
 */
function scanSchemeUri(s, i, start) {
  const n = s.length;
  let k = start;
  let parenDepth = 0;
  const openParens = [];
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c === 34 || c === 39 || c === 96) break;
    // a backslash is an ordinary URI character, even right before a
    // newline (`https://x/of.\` links with the `\` as %5C and the newline
    // is a soft break) — it only ever ends the URI as whitespace does
    if (c < 32) break;
    if (c === 40) { parenDepth++; openParens.push(k); k++; continue; }
    if (c === 41) {
      if (parenDepth > 0) { parenDepth--; openParens.pop(); }
      k++;
      continue;
    }
    k++;
  }
  let end = k;
  if (openParens.length > 0) { end = openParens[0]; }
  if (end <= start) return null;
  // a URI body that starts with a backslash is not a link at all
  // (`tests:\` stays literal text, the `\`+newline is a hard break)
  if (s.charCodeAt(start) === 92) return null;
  // a scheme autolink needs a hierarchical URL (`//`) or an email-like
  // address (`@`): a bare `scheme:word` (`link:foo`, `config:.`,
  // `server:?`, `http:foo`) is literal text, not a link
  {
    const body = s.slice(start, end);
    if (!body.includes('//') && !body.includes('@')) return null;
  }
  // if the URI holds an email address (mailto:/xmpp: — no `/` before the
  // `@`), the domain's last label must not end with `-` or `_` — otherwise
  // the whole thing is literal text, not an autolink (checked on the RAW
  // uri, before the trailing-punctuation trim below would hide the
  // offending char). A `/` before the `@` means it is a URL path, not an
  // email, so the check is skipped there.
  {
    const uri = s.slice(start, end);
    const at = uri.lastIndexOf('@');
    const slash = uri.indexOf('/');
    // email-like iff an `@` exists and no `/` precedes it (a `/` before
    // the `@` means the `@` sits in a URL path, not an email address)
    if (at >= 0 && (slash < 0 || slash > at)) {
      let dom = uri.slice(at + 1);
      while (dom.endsWith('.')) dom = dom.slice(0, -1);
      const lastDot = dom.lastIndexOf('.');
      const lastLabel = lastDot >= 0 ? dom.slice(lastDot + 1) : dom;
      if (!lastLabel || lastLabel.endsWith('-') || lastLabel.endsWith('_')) return null;
      // an email address has no path: a TRAILING `/` (nothing after it)
      // stays outside the link — but a `/` followed by path content
      // (xmpp:foo@bar.baz/txt) stays inside
      if (dom.endsWith('/')) end = start + at + 1 + dom.length - 1;
      // an email-like URI (xmpp:) keeps only ONE path segment after the
      // domain: `xmpp:foo@bar.baz/txt/bin` links `/txt`, `/bin` stays out
      {
        const firstSlash = dom.indexOf('/');
        if (firstSlash >= 0) {
          const secondSlash = dom.indexOf('/', firstSlash + 1);
          if (secondSlash >= 0) end = start + at + 1 + secondSlash;
        }
      }
    }
  }
  // trim trailing punctuation (? ! . , : * _ ~ and a trailing unbalanced ')')
  while (end > start) {
    const c = s.charCodeAt(end - 1);
    if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 42 || c === 95 || c === 126) { end--; continue; }
    if (c === 41) {
      // a trailing `)` is trimmed only if it has no matching `(`: the
      // depth just before it, ignoring unmatched `)`s in the middle
      // (they are literal URL characters, e.g. `...page=4)](...)`)
      let depth = 0;
      for (let p = start; p < end - 1; p++) {
        const pc = s.charCodeAt(p);
        if (pc === 40) depth++;
        else if (pc === 41 && depth > 0) depth--;
      }
      if (depth === 0) { end--; continue; }
      break;
    }
    if (c === 59) {
      const amp = s.lastIndexOf('&', end - 1);
      if (amp >= i && amp < end - 1) {
        const mid = s.slice(amp + 1, end - 1);
        if (/^[A-Za-z][A-Za-z0-9]*$/.test(mid) || /^#[0-9]+$/.test(mid) || /^#[xX][0-9a-fA-F]+$/.test(mid)) { end = amp; continue; }
      }
      // a lone trailing `;` is punctuation, not part of the URL
      end--; continue;
    }
    break;
  }
  if (end <= start) return null;
  const text = s.slice(i, end);
  return { href: encodeHref(text), text, end };
}

/**
 * Scan a GFM domain + optional path starting at s[i]. If `www` is true, the
 * text starts with 'www.' and the domain must contain a dot after it.
 * Returns {href, text, end} or null.
 */
function scanGfmDomain(s, i, www) {
  const n = s.length;
  let j = www ? i + 4 : i;
  // skip scheme://
  if (!www) {
    const sl = s.indexOf('://', i);
    if (sl < 0) return null;
    j = sl + 3;
  }
  // domain: labels of [a-zA-Z0-9_-]+ separated by '.', must contain a dot
  // and end with a label of at least 2 chars that is not all digits? (GFM:
  // the TLD must be a valid domain label; marked accepts any label.)
  const domainStart = j;
  let dots = 0;
  let lastLabelStart = j;
  let lastLabelLen = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isDomainChar(c)) { j++; continue; }
    if (c === 46) {
      // a dot not followed by a domain char ends the domain here (e.g. a
      // trailing "www.example.com." — the dot is trimmed punctuation)
      if (j === domainStart || j + 1 >= n || !isDomainChar(s.charCodeAt(j + 1))) break;
      dots++;
      lastLabelStart = j + 1;
      j++;
      continue;
    }
    break;
  }
  if (j === domainStart) return null;
  lastLabelLen = j - lastLabelStart;
  if (dots === 0) return null;
  if (lastLabelLen < 1) return null;
  // optional path: /... (and ?... #...) — ends at whitespace or < or " or ' or backtick
  let k = j;
  let parenDepth = 0;
  const openParens = []; // positions of '(' not yet closed
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c === 34 || c === 39 || c === 96) break;
    // a backslash is an ordinary URL character, even right before a
    // newline (`www.flux.com\` links with the `\` as %5C)
    if (c === 40) { parenDepth++; openParens.push(k); k++; continue; }
    if (c === 41) {
      // a ')' is included even when it closes nothing — it may be followed
      // by more URL text; only a *trailing* unbalanced ')' is trimmed below
      if (parenDepth > 0) { parenDepth--; openParens.pop(); }
      k++;
      continue;
    }
    k++;
  }
  // an unmatched '(' truncates the URL before it (the part before the first
  // unmatched '(' is balanced, so parenDepth is 0 there)
  let end = k;
  if (openParens.length > 0) { end = openParens[0]; parenDepth = 0; }
  // trim trailing punctuation: ? ! . , : * _ ~, and a trailing ')' only
  // when it has no matching `(` (depth just before it is 0, ignoring
  // unmatched `)`s in the middle — they are literal URL characters)
  while (end > domainStart) {
    const c = s.charCodeAt(end - 1);
    if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 42 || c === 95 || c === 126) { end--; continue; }
    if (c === 41) {
      let depth = 0;
      for (let p = i; p < end - 1; p++) {
        const pc = s.charCodeAt(p);
        if (pc === 40) depth++;
        else if (pc === 41 && depth > 0) depth--;
      }
      if (depth === 0) { end--; continue; }
      break;
    }
    if (c === 59) {
      // a trailing ; that ends an entity-like &...; trims the WHOLE
      // entity-like suffix (the &...; is not part of the URL)
      const amp = s.lastIndexOf('&', end - 1);
      if (amp >= i && amp < end - 1) {
        const mid = s.slice(amp + 1, end - 1);
        if (/^[A-Za-z][A-Za-z0-9]*$/.test(mid) || /^#[0-9]+$/.test(mid) || /^#[xX][0-9a-fA-F]+$/.test(mid)) { end = amp; continue; }
      }
      // a lone trailing `;` is punctuation, not part of the URL
      end--; continue;
    }
    break;
  }
  if (end <= domainStart) return null;
  const text = s.slice(i, end);
  const href = encodeHref(www ? 'http://' + text : text);
  return { href, text, end };
}

/**
 * Lookahead: will the `[` at source index `openIdx` form a link?
 * Finds its matching `]` (depth-counting, skipping escapes and code
 * spans), then checks whether a valid link follows: an inline `(...)`,
 * a reference label `[label]`, or a shortcut reference that exists in
 * `refs`. Used to suppress extended autolinks inside link text.
 */
function bracketWillLink(s, openIdx, refs) {
  const n = s.length;
  let depth = 0;
  let i = openIdx + 1;
  let seenBacktick = false;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n) { i += 2; continue; }
    if (c === 96) {
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      const run = j - i;
      // only the FIRST backtick run in the bracket text can block the
      // link. It pairs with the NEXT backtick run: same length and the
      // `]` inside the span => the bracket cannot link (the `]` is inside
      // a code span). Different length next run => look for the next
      // same-length run: if it closes BEFORE the `]` and the intervening
      // run is shorter, the code span's content holds a backtick and the
      // bracket cannot link; if the same-length closer is past the `]`,
      // the intervening run means the opener is unmatched and the bracket
      // can link (e.g. `` ``url` `` still links). Later runs are skipped
      // without a blocking check.
      if (!seenBacktick) {
        seenBacktick = true;
        const findRun = (from) => {
          let k = from;
          while (k < n) {
            const kc = s.charCodeAt(k);
            if (kc === 92 && k + 1 < n) { k += 2; continue; }
            if (kc === 96) {
              let m = k;
              while (m < n && s.charCodeAt(m) === 96) m++;
              return { pos: k, len: m - k, end: m };
            }
            k++;
          }
          return null;
        };
        const hasBracketBetween = (a, b) => {
          for (let p = a; p < b; p++) if (s.charCodeAt(p) === 93) return true;
          return false;
        };
        const nxt = findRun(j);
        if (nxt && nxt.len === run) {
          if (hasBracketBetween(j, nxt.pos)) return false;
          i = nxt.end;
          continue;
        }
        if (nxt) {
          // different-length next run: find the next same-length closer
          let k = nxt.end;
          let close = null;
          while (k < n) {
            const r = findRun(k);
            if (!r) break;
            if (r.len === run) { close = r; break; }
            k = r.end;
          }
          if (close && !hasBracketBetween(j, close.pos) && nxt.len < run) return false;
        }
      }
      i = j;
      continue;
    }
    if (c === 91) {
      // a link's text may not contain another link: if this nested
      // bracket will itself form a link, the outer bracket cannot
      if (bracketWillLink(s, i, refs)) return false;
      depth++; i++; continue;
    }
    if (c === 93) {
      if (depth === 0) {
        const after = i + 1;
        if (after < n && s.charCodeAt(after) === 40) {
          return parseInlineLink(s, after) !== null;
        }
        if (after < n && s.charCodeAt(after) === 91) {
          const lab = parseLabel(s, after);
          if (!lab) return false;
          return refs.has(normalizeLabel(lab.label));
        }
        const label = normalizeLabel(s.slice(openIdx + 1, i));
        if (label.length === 0) return false;
        return refs.has(label);
      }
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * True when the current scan position sits inside the text of a bracket
 * that will become a link — extended autolinks (scheme/www/email) are
 * suppressed there. `<...>` autolinks are NOT suppressed.
 */
function insideLinkText(s, delims, refs) {
  for (let d = delims.length - 1; d >= 0; d--) {
    const dl = delims[d];
    if (dl.ch === '[' || dl.ch === '!') {
      const openIdx = dl.ch === '!' ? dl.src + 1 : dl.src;
      if (bracketWillLink(s, openIdx, refs)) return true;
    }
  }
  return false;
}

/**
 * Parse inline content of a leaf block.
 * `text` is the raw text (lines joined with \n). `refs` is the reference map.
 * Returns the head node of a flat doubly-linked list.
 */
// does `text` contain a backtick run of length >= 2 with no matching run
// of the same length later in it? (a code span pairs an opening run with
// the next run of the same length; a leftover run is unmatched. Only runs
// of length >= 2 suppress later emphasis — a lone single backtick does not.)
function hasUnmatchedBacktickRun(text) {
  const stack = [];
  let k = 0;
  while (k < text.length) {
    if (text.charCodeAt(k) === 96) {
      let m = k;
      while (m < text.length && text.charCodeAt(m) === 96) m++;
      const run = m - k;
      if (stack.length > 0 && stack[stack.length - 1] === run) stack.pop();
      else stack.push(run);
      k = m;
    } else k++;
  }
  return stack.some((r) => r >= 2);
}

function parseInline(text, refs) {
  const s = text;
  const n = s.length;
  let head = null, tail = null;
  let textBuf = '';
  const delims = []; // delimiter nodes in scan order
  // source positions just past links/images whose text held an unmatched
  // backtick run, and source positions where code spans open: an emphasis
  // span is suppressed when an unmatched-backtick link ends before its
  // opener and a code span starts after its closer (marked suppresses
  // emphasis between such a link and a code span that follows it)
  const unmatchedLinkEnds = [];
  const codeSpanStarts = [];

  function flushText() {
    if (textBuf.length === 0) return;
    const node = newNode('text');
    node.s = textBuf;
    textBuf = '';
    append(node);
  }
  function append(node) {
    if (!head) { head = tail = node; }
    else { tail.next = node; node.prev = tail; tail = node; }
  }
  function addDelim(node) {
    flushText();
    append(node);
    delims.push(node);
  }

  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);

    // newline: soft break, or hard break (2+ trailing spaces, or backslash handled below)
    if (c === 10) {
      flushText();
      const node = newNode('br');
      // hard break if the text before ends with >= 2 spaces
      if (tail && tail.t === 'text') {
        const t = tail.s;
        let sp = 0;
        while (sp < t.length && t.charCodeAt(t.length - 1 - sp) === 32) sp++;
        if (sp >= 2) {
          tail.s = t.slice(0, t.length - sp);
          if (tail.s === '') { // remove empty text node
            const p = tail.prev;
            if (p) p.next = null;
            else head = null;
            tail = p;
          }
          node.t = 'br';
          append(node);
          i++;
          // a hard break strips the next line's leading indent
          while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
          continue;
        }
      }
      node.t = 'soft';
      append(node);
      i++;
      continue;
    }

    // backslash
    if (c === 92) {
      if (i + 1 < n) {
        const nx = s.charCodeAt(i + 1);
        if (nx === 10) {
          flushText();
          const node = newNode('br');
          append(node);
          i += 2;
          // a hard break strips the next line's leading indent
          while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
          continue;
        }
        if (isPunct(nx)) { textBuf += s[i + 1]; i += 2; continue; }
      }
      textBuf += '\\';
      i++;
      continue;
    }

    // backtick run -> code span
    if (c === 96) {
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      const run = j - i;
      // a code span inside a link's bracket text is confined to that
      // text — but ONLY when the bracket will actually form a link:
      // `[docs each ``url`](...)` has an unbalanced `` ``url` ``
      // (2 open, 1 close) and must NOT swallow the `]` to pair with a
      // later `` `` `` run — the link forms and the backticks stay
      // literal in its text. When the bracket will NOT link (e.g.
      // `[foo`][ref]`), the code span may span past the `]` as usual.
      let searchEnd = n;
      for (let d = delims.length - 1; d >= 0; d--) {
        if (delims[d].ch === '[' || delims[d].ch === '!') {
          const openIdx = delims[d].ch === '!' ? delims[d].src + 1 : delims[d].src;
          if (bracketWillLink(s, openIdx, refs)) {
            let q = j;
            while (q < n) {
              const qc = s.charCodeAt(q);
              if (qc === 92 && q + 1 < n) { q += 2; continue; }
              if (qc === 93) { searchEnd = q; break; }
              q++;
            }
          }
          break;
        }
      }
      // find a matching run of exactly `run` backticks
      let k = j;
      let match = -1;
      while (k < searchEnd) {
        if (s.charCodeAt(k) === 96) {
          let m = k;
          while (m < searchEnd && s.charCodeAt(m) === 96) m++;
          if (m - k === run) { match = k; break; }
          k = m;
        } else k++;
      }
      if (match >= 0) {
        flushText();
        let content = s.slice(j, match);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        const node = newNode('code');
        node.s = content;
        append(node);
        codeSpanStarts.push(i);
        i = match + run;
        continue;
      }
      textBuf += s.slice(i, j);
      i = j;
      continue;
    }

    // emphasis delimiters * _ ~
    if (c === 42 || c === 95 || c === 126) {
      let j = i;
      while (j < n && s.charCodeAt(j) === c) j++;
      const run = j - i;
      // a single ~ is a strikethrough delimiter too (GFM: ~there~ is <del>),
      // but a run of 3+ tildes never forms strikethrough (~~~not~~~ is literal)
      if (c === 126 && run >= 3) { textBuf += s.slice(i, j); i = j; continue; }
      const [lf, rf] = flanking(s, i, run);
      let canOpen, canClose;
      if (c === 95) {
        canOpen = lf && (!rf || (i > 0 && isUniPunct(s.charCodeAt(i - 1))));
        canClose = rf && (!lf || (i + run < n && isUniPunct(s.charCodeAt(i + run))));
      } else {
        canOpen = lf;
        canClose = rf;
      }
      const node = newNode('delim');
      node.ch = String.fromCharCode(c);
      node.n = run;
      node.canOpen = canOpen;
      node.canClose = canClose;
      node.src = i;
      addDelim(node);
      i = j;
      continue;
    }

    // [ and ![
    if (c === 91 || (c === 33 && i + 1 < n && s.charCodeAt(i + 1) === 91)) {
      const node = newNode('delim');
      if (c === 33) { node.ch = '!'; node.src = i; addDelim(node); i += 2; }
      else { node.ch = '['; node.src = i; addDelim(node); i++; }
      continue;
    }

    // ] -> try to form a link
    if (c === 93) {
      // flush first: the alt text is computed from the nodes between the
      // opener and this `]`, so the text must be in the list already
      flushText();
      const link = tryLink(s, i, delims, refs);
      if (link) {
        if (link.img) {
          // the opener node becomes the img; drop the alt-text nodes after
          // it (their chain head is kept so the alt resolves after emphasis)
          const opener = link.opener;
          opener.t = 'img';
          opener.href = link.href;
          opener.title = link.title;
          opener.alt = '';
          opener.altHead = link.altHead;
          opener.next = null;
          tail = opener;
        } else {
          const node = newNode('linkC');
          append(node);
        }
        // record a link/image whose text holds an unmatched backtick run
        // (it suppresses a later emphasis span when a code span follows).
        // A nested link's backtick does not count: it belongs to the inner
        // link's own text, so a `[` in the text disqualifies it.
        {
          const textStart = link.opener.src + (link.img ? 2 : 1);
          const linkText = s.slice(textStart, i);
          if (!linkText.includes('[') && hasUnmatchedBacktickRun(linkText)) unmatchedLinkEnds.push(link.end);
        }
        i = link.end;
        continue;
      }
      textBuf += ']';
      i++;
      continue;
    }

    // < -> autolink or HTML tag
    if (c === 60) {
      const auto = scanAutolink(s, i);
      if (auto) {
        flushText();
        const node = newNode('auto');
        node.href = auto.href;
        node.s = auto.text;
        append(node);
        i = auto.end;
        continue;
      }
      const tagEnd = scanHtmlTag(s, i);
      if (tagEnd > 0) {
        flushText();
        const node = newNode('html');
        node.s = s.slice(i, tagEnd);
        append(node);
        i = tagEnd;
        continue;
      }
      textBuf += '<';
      i++;
      continue;
    }

    // & -> entity: numeric decodes to a char, named stays verbatim (own node)
    if (c === 38) {
      const e = scanEntity(s, i);
      if (e) {
        if (e.kind === 'numeric') { textBuf += e.ch; i = e.end; continue; }
        flushText();
        const node = newNode('ent');
        node.s = e.text;
        append(node);
        i = e.end;
        continue;
      }
      textBuf += '&';
      i++;
      continue;
    }

    // GFM extended autolink: www. / scheme:// / email (at @)
    if (c === 64) {
      // email: look back through the SOURCE for the local part — it may
      // span nodes (a `_`/`*`/`~` inside it is a delimiter node, not text)
      const isLocalCh = (cc) => (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) ||
        cc === 46 || cc === 33 || cc === 35 || cc === 36 || cc === 37 || cc === 38 || cc === 39 ||
        cc === 42 || cc === 43 || cc === 45 || cc === 47 || cc === 61 || cc === 63 || cc === 94 ||
        cc === 95 || cc === 96 || cc === 123 || cc === 124 || cc === 125 || cc === 126;
      let ls = i;
      // the look-back stops at an emphasis delimiter run — a `_`/`*`/`~`
      // that is a delimiter node is not part of the local part
      // (`__because@...` → local `because`, not `__because`)
      const inDelimRange = (p) => {
        for (let d = 0; d < delims.length; d++) {
          const dl = delims[d];
          // only a delimiter that CAN open emphasis is a real opener —
          // a dead `_` (e.g. inside `foo_bar`) is part of the local part
          if ((dl.ch === '*' || dl.ch === '_' || dl.ch === '~') && dl.canOpen && p >= dl.src && p < dl.src + dl.n) return true;
        }
        return false;
      };
      while (ls > 0 && isLocalCh(s.charCodeAt(ls - 1)) && !inDelimRange(ls - 1)) ls--;
      if (ls < i) {
        const local = s.slice(ls, i);
        const prevCh = ls > 0 ? s.charCodeAt(ls - 1) : -1;
        const prevOk = prevCh < 0 || isUniSpace(prevCh) || prevCh === 42 || prevCh === 95 || prevCh === 126 || prevCh === 40;
        if (prevOk) {
          // parse domain after @
          let j = i + 1;
          let dots = 0;
          let lastDot = -1;
          while (j < n) {
            const ch = s.charCodeAt(j);
            if (isDomainChar(ch)) {
              // a `_` run is a domain char only mid-domain: a trailing `_`
              // run (followed by a non-domain char) is a closing emphasis
              // delimiter when an open `_` delimiter exists — the domain
              // stops before it (doc-04: `__because@mark.example.com__`)
              if (ch === 95) {
                let k = j;
                while (k < n && s.charCodeAt(k) === 95) k++;
                const after = k < n ? s.charCodeAt(k) : -1;
                if (after !== 46 && !isDomainChar(after)) {
                  let hasOpen = false;
                  for (let d = 0; d < delims.length; d++) if (delims[d].ch === '_' && delims[d].canOpen && delims[d].n > 0) { hasOpen = true; break; }
                  if (hasOpen) break;
                }
              }
              j++; continue;
            }
            if (ch === 46) {
              if (j === i + 1 || j + 1 >= n || !isDomainChar(s.charCodeAt(j + 1))) break;
              dots++;
              lastDot = j;
              j++;
              continue;
            }
            break;
          }
          // the domain's last label may not end with - or _ (a trailing
          // dot is different: it is trimmed and the email still forms)
          const lastCh = j > i + 1 ? s.charCodeAt(j - 1) : -1;
          if (dots > 0 && lastDot > 0 && j - lastDot > 1 && lastCh !== 45 && lastCh !== 95 && !insideLinkText(s, delims, refs)) {
            const domain = s.slice(i + 1, j);
            // rewind the local part out of the node list + text buffer:
            // it may span text nodes and emphasis delimiter nodes
            let remaining = local.length;
            if (textBuf.length > 0) {
              if (textBuf.length >= remaining) { textBuf = textBuf.slice(0, textBuf.length - remaining); remaining = 0; }
              else { remaining -= textBuf.length; textBuf = ''; }
            }
            while (remaining > 0 && tail) {
              const node = tail;
              if (node.t === 'text') {
                if (node.s.length >= remaining) {
                  node.s = node.s.slice(0, node.s.length - remaining);
                  remaining = 0;
                  if (node.s === '') {
                    const p = node.prev;
                    if (p) p.next = null; else head = null;
                    tail = p;
                  }
                } else {
                  remaining -= node.s.length;
                  const p = node.prev;
                  if (p) p.next = null; else head = null;
                  tail = p;
                }
              } else if (node.t === 'delim' && (node.ch === '*' || node.ch === '_' || node.ch === '~')) {
                if (node.n >= remaining) {
                  node.n -= remaining;
                  remaining = 0;
                  if (node.n === 0) {
                    const p = node.prev;
                    if (p) p.next = null; else head = null;
                    tail = p;
                    const di = delims.indexOf(node);
                    if (di >= 0) delims.splice(di, 1);
                  }
                } else {
                  remaining -= node.n;
                  const p = node.prev;
                  if (p) p.next = null; else head = null;
                  tail = p;
                  const di = delims.indexOf(node);
                  if (di >= 0) delims.splice(di, 1);
                }
              } else break; // cannot rewind past a non-text node
            }
            if (remaining === 0) {
              flushText();
              const node = newNode('auto');
              node.href = 'mailto:' + encodeHref(local + '@' + domain);
              node.s = local + '@' + domain;
              append(node);
              i = j;
              continue;
            }
          }
        }
      }
      textBuf += '@';
      i++;
      continue;
    }
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      // possible www. / scheme:// start (any scheme: http, ftp, ssh, ...)
      const prevCh = i > 0 ? s.charCodeAt(i - 1) : -1;
      const ext = scanExtendedAutolink(s, i, prevCh);
      if (ext && !insideLinkText(s, delims, refs)) {
        flushText();
        const node = newNode('auto');
        node.href = ext.href;
        node.s = ext.text;
        append(node);
        i = ext.end;
        continue;
      }
    }

    // plain character
    textBuf += s[i];
    i++;
  }
  flushText();

  processEmphasis(head, delims, unmatchedLinkEnds, codeSpanStarts);
  // resolve image alt text now that emphasis markers are settled
  {
    let cur = head;
    while (cur) {
      if (cur.t === 'img' && cur.altHead) {
        cur.alt = altTextFromChain(cur.altHead);
        cur.altHead = null;
      }
      cur = cur.next;
    }
  }
  return head;
}

/**
 * Try to form a link/image at the `]` at s[i]. `delims` is the live delimiter
 * list. On success: converts the opener delim into linkO/img (or removes it
 * for images — the img is emitted by the caller), removes used delims, and
 * returns {href, title, alt, end, img}. The caller appends the closing node.
 */
/**
 * True when the link text holds a multi-backtick code span whose content
 * itself contains a (shorter) backtick run AND the span is not the last
 * thing in the text — marked does not form a link in that case (the code
 * span is rendered, the `[` stays literal). A span ending exactly at the
 * text's end still links. A single-backtick span cannot hold a backtick;
 * an unmatched run is literal text and does not block.
 */
function linkTextHasInnerBacktick(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92 && i + 1 < n) { i += 2; continue; }
    if (c === 96) {
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      const run = j - i;
      if (run >= 2) {
        let k = j;
        let close = -1, closeEnd = -1;
        let innerShorter = false;
        while (k < n) {
          const kc = text.charCodeAt(k);
          if (kc === 92 && k + 1 < n) { k += 2; continue; }
          if (kc === 96) {
            let m = k;
            while (m < n && text.charCodeAt(m) === 96) m++;
            const len = m - k;
            if (len === run) { close = k; closeEnd = m; break; }
            if (len < run) innerShorter = true;
            k = m;
          } else k++;
        }
        if (close >= 0 && innerShorter && closeEnd < n) return true;
        if (close >= 0) { i = closeEnd; continue; }
      }
      i = j;
      continue;
    }
    i++;
  }
  return false;
}

function tryLink(s, i, delims, refs) {
  // find nearest unmatched [ or ![ delim
  let oi = -1;
  for (let k = delims.length - 1; k >= 0; k--) {
    const d = delims[k];
    if (d.ch === '[' || d.ch === '!') { oi = k; break; }
  }
  if (oi < 0) return null;
  const opener = delims[oi];
  // this `]` closes the opener's bracket whether or not a link forms, so
  // the opener leaves the delimiter list now (a later `]` must not pair
  // with an already-closed `[`, e.g. `[a [b]][ref]` pairs the outer `]`
  // with the outer `[`, not with `[b`)
  delims.splice(oi, 1);
  const isImg = opener.ch === '!';
  // a LINK may not contain another link: if a linkO node already sits
  // inside this bracket's text, the outer link does not form. An IMAGE
  // inside a link is fine ([![alt](img)](url) is a linked image), and an
  // image's alt text may itself contain links (they resolve to their text
  // in the alt) — so this check only applies when forming a link.
  if (!isImg) {
    let cur = opener.next;
    while (cur) {
      if (cur.t === 'linkO') return null;
      cur = cur.next;
    }
  }
  const textStart = opener.src + (isImg ? 2 : 1);
  const linkText = s.slice(textStart, i);
  // a link whose text holds a multi-backtick code span containing a
  // shorter backtick run does not form (marked renders the code span
  // and leaves the `[` literal). Emphasis inside such a failed link
  // text does not form either, so its delimiters are disabled.
  // Fast path: without a double backtick the check cannot trigger.
  if (!isImg && linkText.includes('``') && linkTextHasInnerBacktick(linkText)) {
    for (let k = 0; k < delims.length; k++) {
      const dl = delims[k];
      if ((dl.ch === '*' || dl.ch === '_' || dl.ch === '~') && dl.src >= textStart && dl.src < i) {
        dl.canOpen = false;
        dl.canClose = false;
      }
    }
    return null;
  }

  let href = null, title = null, end = i + 1;
  const after = i + 1;
  if (after < s.length && s.charCodeAt(after) === 40) {
    const l = parseInlineLink(s, after);
    if (l) {
      href = l.href;
      title = l.title;
      end = l.end;
    } else {
      // an invalid inline destination is not a link — but the bracket may
      // still be a shortcut reference ([foo](not a link) + [foo]: /url1
      // resolves [foo] to /url1 and leaves "(not a link)" as text)
      const label = normalizeLabel(linkText);
      if (label.length === 0) return null;
      const ref = refs.get(label);
      if (!ref) return null;
      href = ref.href;
      title = ref.title;
      end = i + 1;
    }
  } else if (after < s.length && s.charCodeAt(after) === 91) {
    // a collapsed reference [foo][] uses the link text itself as the label
    if (after + 1 < s.length && s.charCodeAt(after + 1) === 93) {
      const ref = refs.get(normalizeLabel(linkText));
      if (!ref) return null;
      href = ref.href;
      title = ref.title;
      end = after + 2;
    } else {
      const lab = parseLabel(s, after);
      if (!lab) return null;
      const ref = refs.get(normalizeLabel(lab.label));
      if (!ref) return null;
      href = ref.href;
      title = ref.title;
      end = lab.end;
    }
  } else {
    // shortcut reference
    const label = normalizeLabel(linkText);
    if (label.length === 0) return null;
    const ref = refs.get(label);
    if (!ref) return null;
    href = ref.href;
    title = ref.title;
  }

  // the href is percent-encoded the way marked does it (encodeHref).
  href = encodeHref(href);

  // the image alt text is computed AFTER emphasis runs (paired emphasis
  // markers vanish from the alt), so return the head of the alt-text node
  // chain instead of a string; the caller stores it on the img node and
  // resolves it once processEmphasis has finished.
  const altHead = opener.next;

  // convert the opener delim into linkO (for images, the caller converts it
  // into an img node and drops the alt-text nodes after it)
  if (!isImg) {
    opener.t = 'linkO';
    opener.href = href;
    opener.title = title;
  }
  return { href, title, altHead, end, img: isImg, opener };
}

/**
 * Plain-text content of an image's alt-text node chain (after emphasis
 * processing). Paired emphasis markers are emO/emC nodes and contribute
 * nothing; unpaired delimiters contribute their literal characters.
 */
function altTextFromChain(head) {
  let alt = '';
  let cur = head;
  while (cur) {
    if (cur.t === 'text' || cur.t === 'ent' || cur.t === 'code' || cur.t === 'html' || cur.t === 'auto') alt += cur.s;
    else if (cur.t === 'soft' || cur.t === 'br') alt += '\n';
    else if (cur.t === 'delim') {
      if (cur.ch === '[') alt += '[';
      else if (cur.ch === '!') alt += '![';
      else alt += cur.ch.repeat(cur.n);
    }
    // an image nested in alt text contributes its own alt text
    // (resolved recursively — its `alt` field may not be set yet)
    else if (cur.t === 'img') alt += altTextFromChain(cur.altHead);
    // emO/emC/stO/stC/delO/delC/linkO/linkC contribute nothing
    cur = cur.next;
  }
  return alt;
}

/** Emphasis / strong / strikethrough processing over the delimiter list. */
// an emphasis span (opener o, closer d) is suppressed when an
// unmatched-backtick link ends before the opener and a code span starts
// after the closer
function emphasisSuppressedByBacktickLink(o, d, unmatchedLinkEnds, codeSpanStarts) {
  if (!unmatchedLinkEnds || unmatchedLinkEnds.length === 0) return false;
  if (!codeSpanStarts || codeSpanStarts.length === 0) return false;
  let hasLink = false;
  for (const e of unmatchedLinkEnds) {
    if (e <= o.src) { hasLink = true; break; }
  }
  if (!hasLink) return false;
  for (const c of codeSpanStarts) {
    if (c > d.src) return true;
  }
  return false;
}

function processEmphasis(head, delims, unmatchedLinkEnds, codeSpanStarts) {
  // Build a live array of active delimiter nodes (opener/closer candidates).
  // We iterate with an index; nodes are removed from the list when exhausted.
  let di = 0;
  while (di < delims.length) {
    const d = delims[di];
    if (d.removed || d.n === 0 || !d.canClose || (d.ch !== '*' && d.ch !== '_' && d.ch !== '~')) { di++; continue; }
    // find an opener before d
    let oi = di - 1;
    let matched = false;
    while (oi >= 0) {
      const o = delims[oi];
      if (o.removed || o.n === 0 || !o.canOpen || o.ch !== d.ch) { oi--; continue; }
      // rule of three
      const bothWays = (d.canOpen && d.canClose) || (o.canOpen && o.canClose);
      if (bothWays) {
        const sum = o.n + d.n;
        if (sum % 3 === 0 && !(o.n % 3 === 0 && d.n % 3 === 0)) { oi--; continue; }
      }
      // do not wrap across an unmatched link boundary inside the range
      if (rangeHasLinkBoundary(o, d)) { oi--; continue; }
      if (rangeHasEmphasisBoundary(o, d)) { oi--; continue; }
      // an unmatched backtick run in a link's text suppresses an emphasis
      // span after that link when a code span follows the span
      if (emphasisSuppressedByBacktickLink(o, d, unmatchedLinkEnds, codeSpanStarts)) { oi--; continue; }
      // do not match across a complete emphasis span when it would leave
      // an odd remainder of the opener (see rangeHasCompleteEmphasis)
      if (o.n > d.n && rangeHasCompleteEmphasis(o, d)) { oi--; continue; }
      // an outer span does not form around a complete inner span when the
      // inner span is followed by non-whitespace text with no delimiter
      // before the closer (`*a **b**c*` stays literal, but `*a **b** c*`
      // and `*a **b***` form the outer em; a `*` delimiter between the
      // inner span and the closer saves it, e.g. `**foo *bar*baz* qux**`)
      if (rangeBlocksByCompleteSpan(o, d)) { oi--; continue; }
      // wrap (strikethrough takes 1 or 2 tildes, like * and _ take 1 or 2)
      const use = (o.n >= 2 && d.n >= 2) ? 2 : 1;
      const openKind = d.ch === '~' ? 'delO' : (use === 2 ? 'stO' : 'emO');
      const closeKind = d.ch === '~' ? 'delC' : (use === 2 ? 'stC' : 'emC');
      const openNode = newNode(openKind);
      const closeNode = newNode(closeKind);
      // insert openNode right after o, closeNode right before d
      openNode.next = o.next;
      openNode.prev = o;
      if (o.next) o.next.prev = openNode;
      o.next = openNode;
      closeNode.prev = d.prev;
      closeNode.next = d;
      if (d.prev) d.prev.next = closeNode;
      d.prev = closeNode;
      o.n -= use;
      d.n -= use;
      matched = true;
      if (o.n === 0) {
        o.removed = true;
        delims.splice(oi, 1);
        di--; // opener removed before current index
      }
      if (d.n === 0) {
        d.removed = true;
        delims.splice(di, 1);
        // d consumed: the next delimiter shifted into di; move on
        break;
      }
      // if the opener still has delimiters it can match this closer again
      // (nested emphasis, e.g. ****foo**** -> <strong><strong>foo</strong></strong>)
      if (o.n > 0) continue; // re-check the same opener, do not oi--
      oi--;
    }
    if (!matched || (di < delims.length && delims[di] === d)) {
      // either no opener matched (move past d) or d was consumed above
      if (di < delims.length && delims[di] === d) di++;
    }
  }
}

/** True if the nodes strictly between o and d contain an unmatched link marker. */
function rangeHasLinkBoundary(o, d) {
  let depth = 0;
  let cur = o.next;
  while (cur && cur !== d) {
    if (cur.t === 'linkO') depth++;
    else if (cur.t === 'linkC') depth--;
    cur = cur.next;
  }
  return depth !== 0;
}

/**
 * True if matching opener `o` with closer `d` would cross an already-formed
 * emphasis boundary: `o` sits inside an <em>/<strong>/<del> span whose
 * closer lies between `o` and `d` (the depth goes negative on the walk).
 * Proper nesting (both inside the same span, or a whole span between them)
 * never goes negative and is allowed.
 */
function rangeHasEmphasisBoundary(o, d) {
  let depth = 0;
  let cur = o.next;
  while (cur && cur !== d) {
    if (cur.t === 'emO' || cur.t === 'stO' || cur.t === 'delO') depth++;
    else if (cur.t === 'emC' || cur.t === 'stC' || cur.t === 'delC') {
      depth--;
      if (depth < 0) return true;
    }
    cur = cur.next;
  }
  return false;
}

/**
 * True if the range (o, d) contains a COMPLETE emphasis span of the same
 * delimiter char (an emO/stO matched by a later emC/stC). A closer that
 * would match an opener across such a span, using fewer delimiters than
 * the opener holds (leaving an odd remainder), must not match — the span
 * already "used" the inner emphasis, and the outer run belongs to a later
 * closer that takes it whole (`**foo *bar*baz* qux**` -> the `*` after
 * `baz` stays literal so the final `**` forms the <strong>).
 */
function rangeHasCompleteEmphasis(o, d) {
  let depth = 0;
  let cur = o.next;
  while (cur && cur !== d) {
    if (cur.t === 'emO' || cur.t === 'stO') depth++;
    else if (cur.t === 'emC' || cur.t === 'stC') {
      if (depth > 0) return true; // a complete em/strong span sits inside
      depth--;
    }
    cur = cur.next;
  }
  return false;
}

/**
 * True if the range (o, d) holds a complete em/strong span that blocks the
 * outer match: the span's opener is DETACHED (preceded by whitespace or
 * nothing) AND its closer is followed by a WORD character (letter/digit)
 * with no live delimiter between the span and the closer d.
 * (`*a **b**c*`, `*foo **bar**baz*` stay literal; `*foo**bar**baz*`,
 * `*a **b** c*`, `*a **b***`, `__foo, __bar__, baz__`, `*(*foo*)*` form;
 * a `*` delimiter between the inner span and the closer saves it, e.g.
 * `**foo *bar*baz* qux**`.)
 */
function rangeBlocksByCompleteSpan(o, d) {
  let depth = 0;
  let openNode = null;
  let cur = o.next;
  const spans = [];
  while (cur && cur !== d) {
    if (cur.t === 'emO' || cur.t === 'stO' || cur.t === 'delO') {
      if (depth === 0) openNode = cur;
      depth++;
    } else if (cur.t === 'emC' || cur.t === 'stC' || cur.t === 'delC') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && openNode) { spans.push({ open: openNode, close: cur }); openNode = null; }
      } else depth--;
    }
    cur = cur.next;
  }
  if (depth !== 0 || spans.length === 0) return false;
  // when the opener is already strong-capable (n>=2) and the closer
  // carries MORE delimiters than the opener, the match leaves a leftover
  // on the closer side and is not blocked
  // (`**by command *tool*one***` forms the outer strong)
  if (o.n >= 2 && d.n > o.n) return false;
  // the outer match will use this many delimiters (1 for em, 2 for strong)
  const outerUse = (o.n >= 2 && d.n >= 2) ? 2 : 1;
  for (const sp of spans) {
    // the guard only applies when the inner span uses the SAME delimiter
    // character as the outer match but a DIFFERENT strength (one em, one
    // strong): same-strength nesting (`*a *b* c*`, `__foo, __bar__, baz__`)
    // and cross-character nesting (`_use **output**parser_`) both form.
    const openDelim = sp.open.prev;
    const innerCh = openDelim && openDelim.t === 'delim' ? openDelim.ch : null;
    if (innerCh !== o.ch) continue;
    const innerUse = sp.open.t === 'stO' ? 2 : 1;
    if (innerUse === outerUse) continue;
    // is the span's opener detached? The opener delimiter sits right
    // before the emO/stO/delO node; check the node before that.
    let detached = true;
    if (openDelim) {
      const before = openDelim.prev;
      if (before) {
        if (before.t === 'text') {
          detached = before.s.length === 0 || isUniSpace(before.s.charCodeAt(before.s.length - 1));
        } else if (before.t === 'soft' || before.t === 'br') detached = true;
        else detached = false;
      }
    }
    if (!detached) continue;
    // is the span's closer followed by a word char, with no live
    // delimiter between the span and the outer closer d?
    let firstIsWord = null;
    let node = sp.close.next;
    let reachedD = false;
    while (node && node !== d) {
      // a live delimiter between the inner span and the closer saves the
      // match — but only when the outer match is at least as strong as the
      // inner span. A weaker outer (`*` em) around a stronger inner
      // (`**` strong) is NOT saved: the `*` must not steal the closer
      // from an outer `**` (`**a *b **c**d* e**` forms the outer strong).
      if (node.t === 'delim' && (node.ch === '*' || node.ch === '_' || node.ch === '~') && node.n > 0) {
        if (outerUse >= innerUse) { firstIsWord = null; break; }
        node = node.next;
        continue;
      }
      // a soft line break / hard break is whitespace after the span
      if ((node.t === 'soft' || node.t === 'br') && firstIsWord === null) { firstIsWord = false; break; }
      if (node.t === 'text' && node.s.length > 0 && firstIsWord === null) {
        const c = node.s.charCodeAt(0);
        firstIsWord = !isUniSpace(c) && !isUniPunct(c);
        if (!firstIsWord) break;
      }
      node = node.next;
    }
    if (node === d) reachedD = true;
    if (reachedD && firstIsWord === true) return true;
  }
  return false;
}

/** Render an inline node list to HTML. */
function renderInline(head) {
  let out = '';
  let cur = head;
  while (cur) {
    switch (cur.t) {
      case 'text': out += esc(cur.s); break;
      case 'ent': out += cur.s; break; // named entity kept verbatim
      case 'code': out += '<code>' + esc(cur.s) + '</code>'; break;
      case 'html': out += cur.s; break;
      case 'br': out += '<br>'; break;
      case 'soft': out += '\n'; break;
      case 'delim':
        if (cur.ch === '[') out += '[';
        else if (cur.ch === '!') out += '![';
        else out += cur.ch.repeat(cur.n);
        break;
      case 'linkO':
        out += '<a href="' + escAttr(cur.href) + '"';
        if (cur.title != null) out += ' title="' + escAttr(cur.title) + '"';
        out += '>';
        break;
      case 'linkC': out += '</a>'; break;
      case 'img':
        out += '<img src="' + escAttr(cur.href) + '" alt="' + escAttr(cur.alt) + '"';
        if (cur.title != null) out += ' title="' + escAttr(cur.title) + '"';
        out += '>';
        break;
      case 'auto':
        out += '<a href="' + escAttr(cur.href) + '">' + esc(cur.s) + '</a>';
        break;
      case 'emO': out += '<em>'; break;
      case 'emC': out += '</em>'; break;
      case 'stO': out += '<strong>'; break;
      case 'stC': out += '</strong>'; break;
      case 'delO': out += '<del>'; break;
      case 'delC': out += '</del>'; break;
      default: break;
    }
    cur = cur.next;
  }
  return out;
}

/* ---------------- block parsing ---------------- */

// A line is { s: string, b: number } — s is the text, b is the absolute
// column of s[0] (0 for top-level lines). Tabs expand to the next multiple
// of 4 in absolute columns; the text itself is never expanded, so tabs stay
// verbatim in code content (marked keeps them).

function indentCols(L) {
  let col = L.b;
  let i = 0;
  const s = L.s;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { col++; i++; }
    else if (ch === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return col - L.b;
}
function isBlank(L) {
  // a line flagged `wsContent` holds whitespace that IS content (a `>`
  // line whose remainder is only spaces, e.g. `>  ` -> ` `) — it is a
  // paragraph line, never a blank separator
  if (L.wsContent) return false;
  const s = L.s;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
/** Remove the first `cols` columns; a straddling tab leaves spaces. Returns a new line object. */
function stripColumns(L, cols) {
  if (cols <= 0) return L;
  const s = L.s;
  let col = L.b;
  let i = 0;
  let prefix = '';
  while (i < s.length && col - L.b < cols) {
    const ch = s.charCodeAt(i);
    if (ch === 9) {
      const w = 4 - (col % 4);
      if (col + w - L.b <= cols) { col += w; i++; }
      else {
        prefix = ' '.repeat(col + w - (L.b + cols));
        col = L.b + cols;
        i++;
        break;
      }
    } else { col++; i++; } // any other char counts as one column (e.g. a list marker)
  }
  return { s: prefix + s.slice(i), b: col };
}

/**
 * Like stripIndent, but for fenced-code content: a tab that straddles the
 * `cols` boundary is removed ENTIRELY (marked drops it whole, leaving no
 * partial spaces), not partially consumed.
 */
function stripFenceIndent(L, cols) {
  if (cols <= 0) return L;
  const s = L.s;
  let col = L.b;
  let i = 0;
  while (i < s.length && col - L.b < cols) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { col++; i++; }
    else if (ch === 9) {
      const w = 4 - (col % 4);
      if (col + w - L.b <= cols) { col += w; i++; }
      else { col += w; i++; break; } // straddling tab: drop it whole
    } else break;
  }
  return { s: s.slice(i), b: col };
}

/**
 * Remove up to `cols` columns of LEADING WHITESPACE only (spaces/tabs).
 * Unlike stripColumns, a non-whitespace char is never removed — a line
 * with less indentation than `cols` keeps its content intact. Used for
 * fenced-code content (the fence's indent is stripped from each line).
 */
function stripIndent(L, cols) {
  if (cols <= 0) return L;
  const s = L.s;
  let col = L.b;
  let i = 0;
  let prefix = '';
  while (i < s.length && col - L.b < cols) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { col++; i++; }
    else if (ch === 9) {
      const w = 4 - (col % 4);
      if (col + w - L.b <= cols) { col += w; i++; }
      else {
        prefix = ' '.repeat(col + w - (L.b + cols));
        col = L.b + cols;
        i++;
        break;
      }
    } else break; // content: stop, do not remove it
  }
  return { s: prefix + s.slice(i), b: col };
}

/** Content string after the leading whitespace (valid when indent < 4, where columns == chars). */
function contentStr(L) {
  return L.s.slice(indentCols(L));
}

function matchAtx(L) {
  const ind = indentCols(L);
  if (ind >= 4) return null;
  const c = L.s.slice(ind);
  if (c[0] !== '#') return null;
  let k = 0;
  while (k < c.length && c[k] === '#') k++;
  if (k > 6) return null;
  if (k < c.length && c[k] !== ' ' && c[k] !== '\t') return null;
  let content = c.slice(k);
  content = content.replace(/ +#+[ \t]*$/, '');
  content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level: k, text: content };
}

function matchFence(L) {
  const ind = indentCols(L);
  if (ind >= 4) return null;
  const c = L.s.slice(ind);
  const ch = c[0];
  if (ch !== '`' && ch !== '~') return null;
  let k = 0;
  while (k < c.length && c[k] === ch) k++;
  if (k < 3) return null;
  let info = c.slice(k).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  // backslash escapes in the info string are resolved (e.g. foo\+bar -> foo+bar)
  if (info.indexOf('\\') >= 0) {
    let resolved = '';
    for (let q = 0; q < info.length; q++) {
      if (info.charCodeAt(q) === 92 && q + 1 < info.length && isPunct(info.charCodeAt(q + 1))) { resolved += info[q + 1]; q++; }
      else resolved += info[q];
    }
    info = resolved;
  }
  return { ch, len: k, info };
}
function matchFenceClose(L, fence) {
  const ind = indentCols(L);
  if (ind >= 4) return false;
  const c = L.s.slice(ind);
  let k = 0;
  while (k < c.length && c[k] === fence.ch) k++;
  if (k < fence.len) return false;
  return c.slice(k).replace(/[ \t]/g, '') === '';
}

function matchThematicBreak(L) {
  const ind = indentCols(L);
  if (ind >= 4) return null;
  const c = L.s.slice(ind);
  const ch = c[0];
  if (ch !== '-' && ch !== '_' && ch !== '*') return false;
  let count = 0;
  for (let i = 0; i < c.length; i++) {
    if (c[i] === ch) count++;
    else if (c[i] !== ' ' && c[i] !== '\t') return false;
  }
  return count >= 3;
}

function matchSetext(L) {
  const ind = indentCols(L);
  if (ind >= 4) return 0;
  const c = L.s.slice(ind).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (c.length === 0) return 0;
  const ch = c[0];
  if (ch !== '=' && ch !== '-') return 0;
  for (let i = 0; i < c.length; i++) if (c[i] !== ch) return 0;
  return ch === '=' ? 1 : 2;
}

const BLOCK_TAGS = new Set(['address','article','aside','base','basefont','blockquote','body','caption','center','col','colgroup','dd','details','dialog','dir','div','dl','dt','fieldset','figcaption','figure','footer','form','frame','frameset','h1','h2','h3','h4','h5','h6','head','header','hr','html','iframe','legend','li','link','main','menu','menuitem','nav','noframes','ol','optgroup','option','p','param','section','source','summary','table','tbody','td','tfoot','th','thead','title','tr','track','ul']);

function htmlBlockType(L) {
  const ind = indentCols(L);
  if (ind >= 4) return 0;
  const c = L.s.slice(ind);
  if (c[0] !== '<') return 0;
  if (/^<(script|pre|style|textarea)([\s>]|$)/i.test(c)) return 1;
  if (c.startsWith('<!--')) return 2;
  if (c.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(c)) return 4;
  if (c.startsWith('<![CDATA[')) return 5;
  const m6 = c.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|$)/);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return 6;
  const tagEnd = scanHtmlTag(L.s, ind);
  if (tagEnd > 0 && L.s.slice(tagEnd).replace(/[ \t]/g, '') === '') return 7;
  return 0;
}

function matchListMarker(L) {
  const ind = indentCols(L);
  if (ind >= 4) return null;
  const c = L.s.slice(ind);
  const ch = c[0];
  if (ch === '-' || ch === '+' || ch === '*') {
    if (c.length === 1 || c[1] === ' ' || c[1] === '\t') {
      return { type: 'bullet', char: ch, indent: ind, width: 1, markerEnd: ind + 1 };
    }
    return null;
  }
  let k = 0;
  while (k < c.length && isDigit(c.charCodeAt(k))) k++;
  if (k === 0 || k > 9) return null;
  const delim = c[k];
  if (delim !== '.' && delim !== ')') return null;
  if (c.length === k + 1 || c[k + 1] === ' ' || c[k + 1] === '\t') {
    return { type: 'ordered', num: parseInt(c.slice(0, k), 10), delim, indent: ind, width: k + 1, markerEnd: ind + k + 1 };
  }
  return null;
}

/** Whitespace columns starting at character index charIdx (startCol = its absolute column). */
function countWsCols(L, charIdx, startCol) {
  const s = L.s;
  let col = startCol;
  let i = charIdx;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { col++; i++; }
    else if (ch === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col - startCol, end: i };
}

function canInterruptParagraph(L, inList = false) {
  if (matchAtx(L)) return true;
  if (matchFence(L)) return true;
  const ht = htmlBlockType(L);
  if (ht >= 1 && ht <= 6) return true;
  const ind = indentCols(L);
  if (ind <= 3 && L.s.slice(ind)[0] === '>') return true;
  if (matchThematicBreak(L)) return true;
  const m = matchListMarker(L);
  if (m) {
    const ws = countWsCols(L, m.markerEnd, m.indent + m.width);
    const empty = ws.end >= L.s.length;
    // an ordered list interrupts a paragraph only when it starts with 1 —
    // EXCEPT inside a list item, where any start number interrupts
    if (!empty && (m.type === 'bullet' || (m.type === 'ordered' && (inList || m.num === 1)))) return true;
  }
  return false;
}

/** Skip spaces/tabs/newlines from s[i]; fail (-1) if it crosses a blank line. */
function skipWsNoBlank(s, i) {
  const n = s.length;
  let j = i;
  let newlines = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9) j++;
    else if (c === 10) { newlines++; if (newlines > 1) return -1; j++; }
    else break;
  }
  return j;
}

/**
 * Try to parse a link reference definition at offset `off` of the joined
 * string `s` (paragraph lines joined with \n). Returns
 * {label, href, title, end} (end at the \n after the definition, or at
 * end-of-string) or null.
 */
function parseDefinition(s, off) {
  const n = s.length;
  let i = off;
  let ind = 0;
  while (i < n && s[i] === ' ' && ind < 3) { i++; ind++; }
  if (i >= n || s[i] !== '[') return null;
  const lab = parseLabel(s, i);
  if (!lab) return null;
  i = lab.end;
  if (i >= n || s[i] !== ':') return null;
  i++;
  let j = skipWsNoBlank(s, i);
  if (j < 0) return null;
  i = j;
  const d = parseLinkDestination(s, i);
  if (!d) return null;
  const href = d.dest;
  i = d.end;
  let title = null;
  let k = i;
  while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
  // a same-line title needs whitespace before it: `[foo]: <bar>(baz)` has
  // none, so the definition is invalid (junk after the destination)
  if (k > i && k < n && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const t = parseLinkTitle(s, k);
    if (!t) return null;
    title = t.title;
    i = t.end;
    let m = i;
    while (m < n && (s[m] === ' ' || s[m] === '\t')) m++;
    if (m < n && s[m] !== '\n') return null;
    i = m;
  } else if (k < n && s[k] === '\n') {
    let m = k + 1;
    while (m < n && (s[m] === ' ' || s[m] === '\t')) m++;
    if (m < n && (s[m] === '"' || s[m] === "'" || s[m] === '(')) {
      const t = parseLinkTitle(s, m);
      let ok = false;
      if (t) {
        let p = t.end;
        while (p < n && (s[p] === ' ' || s[p] === '\t')) p++;
        if (p >= n || s[p] === '\n') { title = t.title; i = p; ok = true; }
      }
      if (!ok) {
        // a title on the next line that is invalid does not kill the
        // definition: it stands without a title and the next line is a
        // separate paragraph (the definition ends at the destination line)
        title = null;
        i = k;
      }
    } else {
      i = k;
    }
  } else {
    if (k < n) return null;
    i = k;
  }
  const label = normalizeLabel(lab.label);
  if (label.length === 0) return null;
  return { label, href, title, end: i };
}

function countNewlinesUpTo(s, off) {
  let c = 0;
  for (let i = 0; i < off && i < s.length; i++) if (s.charCodeAt(i) === 10) c++;
  return c;
}

/** Parse a paragraph (with link reference definitions at its start). */
function parseParagraph(lines, start, end, refs, inList = false) {
  // Definitions are parsed from a bounded window (a definition spans at
  // most a few lines: label, destination, title) so long documents stay
  // linear instead of re-joining the whole remainder per paragraph.
  let j = start;
  while (j < end) {
    const win = lines.slice(j, Math.min(end, j + 12)).map(L => L.s).join('\n');
    const d = parseDefinition(win, 0);
    if (!d) break;
    if (!refs.has(d.label)) refs.set(d.label, { href: d.href, title: d.title });
    let off = d.end;
    let trailingNl = false;
    if (win[off] === '\n') { off++; trailingNl = true; }
    let consumed = countNewlinesUpTo(win, off);
    // a definition running to the end of the input has no trailing newline
    // to count, so the newline count undercounts its lines by one
    if (!trailingNl && off >= win.length) consumed += 1;
    if (consumed <= 0) break; // safety: never stall
    j += consumed;
  }
  if (j >= end || isBlank(lines[j])) return { block: null, next: j };
  // a whitespace-only line (e.g. a `>` line whose remainder is just spaces,
  // flagged wsContent) can CONTINUE a paragraph but never START one — a
  // blockquote of only such lines is empty (cm-240)
  if (lines[j].s.trim() === '') return { block: null, next: j };
  // after definitions, a line that starts a block (blockquote, ATX, ...)
  // is not paragraph text: the paragraph was definitions only
  if (startsBlock(lines[j], false)) return { block: null, next: j };
  // Paragraph lines are kept verbatim: marked does not strip their leading
  // whitespace (e.g. "  foo" renders as <p>  foo</p>).
  const paraLines = [];
  let i = j;
  paraLines.push(lines[i].s);
  i++;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) break;
    // a lazy `===` line (flagged by the container) is paragraph text, never
    // a setext underline. In a blockquote with 2+ lines before it, the line
    // is padded to 4 leading spaces; with 1 line, or in a list, it is kept
    // as-is.
    const st = line.lazySetext ? 0 : matchSetext(line);
    if (st) {
      // a setext heading's content is the paragraph text with leading and
      // trailing whitespace stripped (a plain paragraph keeps it verbatim)
      return { block: { type: 'heading', level: st, text: paraLines.join('\n').trim() }, next: i + 1 };
    }
    // a lazy line (flagged by its container) is paragraph TEXT even if it
    // looks like a list marker or a table header — it never interrupts
    if (!line.lazy) {
      // a table header + delimiter interrupts the paragraph (the table
      // starts here; the paragraph lines so far stay their own paragraph)
      if (tableStart(lines, i, end)) break;
      if (canInterruptParagraph(line, inList)) break;
    }
    if (line.lazySetext === 'bq' && paraLines.length >= 2) {
      const leading = line.s.match(/^ */)[0].length;
      paraLines.push(' '.repeat(Math.max(0, 4 - leading)) + line.s);
    } else {
      paraLines.push(line.s);
    }
    i++;
  }
  return { block: { type: 'para', lines: paraLines }, next: i };
}

/**
 * True if `line` starts a non-paragraph block given whether a paragraph is
 * currently open (paraOpen). Used to track lazy continuation incrementally.
 */
function startsBlock(L, paraOpen) {
  if (matchAtx(L)) return true;
  if (matchFence(L)) return true;
  const ht = htmlBlockType(L);
  if (ht >= 1 && ht <= 6) return true;
  const ind = indentCols(L);
  if (ind <= 3 && L.s.slice(ind)[0] === '>') return true;
  if (matchThematicBreak(L)) return true;
  const m = matchListMarker(L);
  if (m) {
    if (!paraOpen) return true;
    const ws = countWsCols(L, m.markerEnd, m.indent + m.width);
    const empty = ws.end >= L.s.length;
    if (!empty && (m.type === 'bullet' || (m.type === 'ordered' && m.num === 1))) return true;
    return false;
  }
  if (ind >= 4 && !paraOpen) return true; // indented code
  return false;
}

/** Update the "open paragraph" state after appending `line` to a container's sub-lines. */
function trackParaOpen(L, paraOpen) {
  if (isBlank(L)) return false;
  // a paragraph may sit inside nested containers: strip blockquote markers
  // AND list markers to reach the innermost content ("> 1. > foo" is a
  // paragraph line, not a block) — a lazy line must be able to continue it
  let inner = L;
  for (;;) {
    const ind = indentCols(inner);
    if (ind <= 3 && inner.s.slice(ind)[0] === '>') {
      inner = stripBlockquoteMarker(inner);
      if (isBlank(inner)) return false;
      continue;
    }
    const m = matchListMarker(inner);
    if (m) {
      // content after the marker: skip the marker + following whitespace
      const after = m.markerEnd;
      let k = after;
      while (k < inner.s.length && (inner.s.charCodeAt(k) === 32 || inner.s.charCodeAt(k) === 9)) k++;
      if (k >= inner.s.length) return false; // empty item: no paragraph
      inner = { s: inner.s.slice(k), b: inner.b + k };
      continue;
    }
    break;
  }
  if (paraOpen && matchSetext(inner)) return false; // paragraph becomes a heading
  if (startsBlock(inner, paraOpen)) return false;
  return true;
}

/**
 * Expand the tabs in a line's leading whitespace to spaces (based on
 * absolute columns). Tabs after the first non-whitespace char are kept.
 * Marked expands a sub-line's leading tabs when a container marker is
 * stripped (e.g. "> \tfoo" gives a sub-line "  foo"), while tabs in the
 * content itself stay verbatim.
 */
function expandLeadingTabs(L) {
  const s = L.s;
  let i = 0;
  let col = L.b;
  let out = '';
  let hadTab = false;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { out += ' '; col++; i++; }
    else if (ch === 9) {
      hadTab = true;
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    } else break;
  }
  if (!hadTab) return L;
  return { s: out + s.slice(i), b: L.b };
}

/**
 * Strip a blockquote marker (`>` + one optional whitespace column) from a
 * line object. A tab after `>` counts as whitespace: one of its columns is
 * consumed and the rest becomes spaces.
 */
function stripBlockquoteMarker(L) {
  const ind = indentCols(L);
  const gtIdx = ind; // char index of '>' (ind < 4 => all spaces)
  const s = L.s;
  const after = gtIdx + 1;
  if (s[after] === ' ') {
    return expandLeadingTabs({ s: s.slice(after + 1), b: ind + 2 });
  }
  if (s[after] === '\t') {
    const w = 4 - ((ind + 1) % 4);
    return expandLeadingTabs({ s: ' '.repeat(w - 1) + s.slice(after + 1), b: ind + 2 });
  }
  return expandLeadingTabs({ s: s.slice(after), b: ind + 1 });
}

/** Collect a blockquote's sub-lines starting at lines[start]. Returns [subLines, nextIndex]. */
function collectBlockquote(lines, start, end, refs) {
  const sub = [];
  let paraOpen = false;
  let fence = null; // open fenced code block inside this quote (if any)
  let i = start;
  while (i < end) {
    const line = lines[i];
    const ind = indentCols(line);
    if (ind <= 3 && line.s.slice(ind)[0] === '>') {
      const rest = stripBlockquoteMarker(line);
      // a `>` line whose remainder is only spaces (but non-empty) is
      // paragraph CONTENT — the spaces are text, not a blank separator
      // (cm-241: `>  ` -> ` ` stays a paragraph line; bare `>` -> `` is blank)
      if (rest.s.length > 0 && isBlank(rest)) rest.wsContent = true;
      sub.push(rest);
      // track fenced code blocks: their content lines are not paragraphs,
      // and a lazy line inside one ends the blockquote (it cannot be code)
      if (fence) {
        if (matchFenceClose(rest, fence)) fence = null;
      } else {
        const f = matchFence(rest);
        if (f) fence = f;
      }
      paraOpen = fence ? false : trackParaOpen(rest, paraOpen);
      i++;
      continue;
    }
    // a blank line without a `>` marker ends the blockquote (a later `>`
    // line starts a NEW blockquote, it does not continue this one)
    if (isBlank(line)) break;
    // a lazy line inside a fenced code block ends the blockquote
    if (fence) break;
    if (paraOpen) {
      // a lazy line that starts a block (thematic break, ATX, fence, HTML
      // block, blockquote, list) ends the blockquote — it cannot continue
      // the paragraph. A setext `---` is a thematic break, so it ends it
      // too; but a setext `===` is NOT a block start, so as a lazy line it
      // is paragraph TEXT (marked so it is never read as an underline).
      if (matchSetext(line) === 2) break;
      if (startsBlock(line, true)) break;
      // a lazy line indented >= 4 columns loses 4 columns of indent (as if
      // it were indented code); a less-indented lazy line keeps its indent.
      // A lazy line is paragraph TEXT even if it looks like a list marker
      // after stripping (cm-238: `> foo\n    - bar` -> `foo\n- bar`), so it
      // is flagged `lazy` and parseParagraph must not let it interrupt.
      const li = indentCols(line);
      const lazyLine = li >= 4 ? stripIndent(line, 4) : line;
      if (matchSetext(line) === 1) {
        sub.push({ s: lazyLine.s, b: lazyLine.b, lazySetext: 'bq', lazy: true });
      } else {
        sub.push({ s: lazyLine.s, b: lazyLine.b, lazy: true });
      }
      // a lazy line IS paragraph text (even if it looks like a list marker
      // after stripping) — the paragraph stays open
      paraOpen = true;
      i++;
      continue;
    }
    break;
  }
  // trailing blank lines (no `>` marker) end the blockquote; they are not
  // its content (otherwise one would leak into an unclosed fenced code block)
  while (sub.length && isBlank(sub[sub.length - 1])) sub.pop();
  return [sub, i];
}

/** Parse one list item starting at lines[start] (marker already matched). */
function parseListItem(lines, start, end, marker, refs) {
  const line = lines[start];
  const ws = countWsCols(line, marker.markerEnd, marker.indent + marker.width);
  const restBlank = ws.end >= line.s.length;
  let contentIndent;
  if (restBlank) contentIndent = marker.indent + marker.width + 1;
  else if (ws.cols >= 5) contentIndent = marker.indent + marker.width + 1;
  else contentIndent = marker.indent + marker.width + ws.cols;

  const sub = [];
  let paraOpen = false;
  let first = restBlank ? { s: '', b: 0 } : expandLeadingTabs(stripColumns(line, contentIndent));
  // GFM task list: "[ ] ", "[x] " or "[X] " at the start of the item's
  // content (must be followed by a space/tab) becomes a checkbox
  let task = null;
  if (!restBlank) {
    const tm = first.s.match(/^\[( |x|X)\][ \t]+/);
    if (tm) {
      task = tm[1] === ' ' ? 'unchecked' : 'checked';
      first = { s: first.s.slice(tm[0].length), b: first.b + tm[0].length };
    }
  }
  // an empty marker line contributes no content — and its blankness must
  // not make the list loose (the item's real content starts on a later line)
  if (!restBlank) sub.push(first);
  paraOpen = restBlank ? false : trackParaOpen(first, false);
  let i = start + 1;
  // an empty item followed by a blank line is done: the blank ends it, and
  // any indented content after the blank belongs to the enclosing context,
  // not to this item
  if (restBlank && i < end && isBlank(lines[i])) {
    return { blocks: [], next: i, internalBlank: false, endedWithBlank: false, listEnded: false, task };
  }
  let blankRun = 0;
  let listEnded = false;
  while (i < end) {
    const l = lines[i];
    if (isBlank(l)) {
      blankRun++;
      sub.push({ s: '', b: 0 });
      paraOpen = false;
      i++;
      continue;
    }
    blankRun = 0;
    const li = indentCols(l);
    if (li >= contentIndent) {
      const stripped = expandLeadingTabs(stripColumns(l, contentIndent));
      sub.push(stripped);
      paraOpen = trackParaOpen(stripped, paraOpen);
      i++;
      continue;
    }
    const m = matchListMarker(l);
    // a marker ends the item (sibling item) only if it is at the list's
    // level (indent < this item's content indent) AND a valid top-level
    // item start (at most 3 leading spaces). A marker indented 4+ while a
    // paragraph is open is a lazy continuation — paragraph text, not a
    // nested list (cm-312: `   - d\n    - e` -> `d\n- e` inside `d`)
    if (m && m.indent < contentIndent && m.indent <= 3) break;
    // a block that can interrupt a paragraph (thematic break, ATX heading,
    // fenced code, HTML block, blockquote) at the list's level ends the
    // item instead of becoming a lazy continuation
    if (matchThematicBreak(l) || matchAtx(l) || matchFence(l) ||
        (htmlBlockType(l) >= 1 && htmlBlockType(l) <= 6) ||
        (li <= 3 && l.s.slice(li)[0] === '>')) break;
    if (paraOpen) {
      // a setext `---` is a thematic break and ends the item; a setext
      // `===` is NOT a block start, so as a lazy line it is paragraph TEXT
      if (matchSetext(l) === 2) break;
      // a lazy continuation line keeps its leading whitespace VERBATIM
      // when indented < 4 (it is paragraph text) — but a line indented
      // 4+ loses its leading whitespace up to the content indent (it is
      // indented content, not paragraph leading space; cm-291, cm-312).
      // Flagged `lazy`: it is paragraph text even if it looks like a list
      // marker after stripping.
      const stripped = indentCols(l) >= 4
        ? expandLeadingTabs(stripIndent(l, contentIndent))
        : expandLeadingTabs({ s: l.s, b: l.b });
      if (matchSetext(l) === 1) {
        sub.push({ s: stripped.s, b: stripped.b, lazySetext: 'list', lazy: true });
      } else {
        sub.push({ s: stripped.s, b: stripped.b, lazy: true });
      }
      paraOpen = trackParaOpen(stripped, paraOpen);
      i++;
      continue;
    }
    break;
  }
  let trailingBlanks = 0;
  while (sub.length && isBlank(sub[sub.length - 1])) { sub.pop(); trailingBlanks++; }
  // the popped trailing blanks are NOT consumed: they still separate this
  // item from whatever follows in the parent (a code block after a blank
  // loosens the parent item), so `next` rewinds to the first of them
  const next = i - trailingBlanks;
  const blocks = parseBlockList(sub, 0, sub.length, refs, false, true);
  // loose iff two of the item's own blocks are separated by a blank line
  // (a blank inside a fenced code block or a nested list never counts —
  // those blanks are consumed inside their own block, not between blocks)
  let internalBlank = blocks.slice(1).some(b => b.blankBefore);
  // a blank line before a link reference definition also loosens the list:
  // the definition is consumed (no block), so blankBefore never fires for
  // it, but the blank still separates this item from the next (cm-317)
  if (!internalBlank) {
    let inFence = null;
    let sawBlank = false;
    for (const L of sub) {
      if (inFence) {
        if (matchFenceClose(L, inFence)) inFence = null;
        continue;
      }
      const f = matchFence(L);
      if (f) { inFence = f; sawBlank = false; continue; }
      if (isBlank(L)) { sawBlank = true; continue; }
      if (sawBlank && /^\[[^\]]+\]:/.test(L.s)) { internalBlank = true; break; }
      sawBlank = false;
    }
  }
  return { blocks, next, internalBlank, endedWithBlank: trailingBlanks > 0, listEnded, task };
}

/** Parse a list starting at lines[start]. Returns [listNode, nextIndex]. */
function parseList(lines, start, end, refs) {
  const first = matchListMarker(lines[start]);
  const ordered = first.type === 'ordered';
  const delim = ordered ? first.delim : first.char;
  const startNum = ordered ? first.num : null;
  const items = [];
  let i = start;
  let loose = false;
  // a blank line was skipped after the previous item: the list is loose
  // once the NEXT item is found (the blank may have a link reference
  // definition between it and the next marker — cm-317 — so the flag is
  // only cleared when an item is actually parsed, not when the next line
  // is checked)
  let pendingLoose = false;
  while (i < end) {
    // a thematic break that looks like a list item (e.g. "* * *") ends the
    // list instead of starting a new item
    if (matchThematicBreak(lines[i])) break;
    const marker = matchListMarker(lines[i]);
    if (!marker) break;
    if (marker.type !== first.type) break;
    if (ordered) { if (marker.delim !== delim) break; }
    else { if (marker.char !== delim) break; }
    const item = parseListItem(lines, i, end, marker, refs);
    items.push(item);
    if (item.internalBlank) loose = true;
    if (pendingLoose) { loose = true; pendingLoose = false; }
    i = item.next;
    if (item.listEnded) break;
    // a blank line between items does not end the list — skip blanks only
    // when the next non-blank line IS a sibling item (cm-315). If the list
    // ends here, the blank is left for the outer parser: it still separates
    // the next block (cm-325: a blank before `baz` loosens the outer item)
    let j = i;
    while (j < end && isBlank(lines[j])) j++;
    if (j < end) {
      const nm = matchListMarker(lines[j]);
      if (nm && nm.type === first.type && (ordered ? nm.delim === delim : nm.char === delim) && !matchThematicBreak(lines[j])) {
        pendingLoose = j > i;
        i = j;
      }
    }
  }
  for (let k = 0; k < items.length - 1; k++) {
    if (items[k].endedWithBlank) loose = true;
  }
  const list = {
    type: 'list',
    ordered,
    start: startNum,
    tight: !loose,
    items: items.map(it => ({ blocks: it.blocks, task: it.task || null })),
  };
  return [list, i];
}

/**
 * Split a table row line into cells on unescaped `|` (a `\|` stays a literal
 * pipe in the cell text; the inline parser resolves it). A leading/trailing
 * pipe is the table border and does not create a cell. Cells are trimmed.
 */
function splitTableRow(s) {
  const t = s.trim();
  const cells = [];
  let cur = '';
  let i = 0;
  const n = t.length;
  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 92) {
      // `\|` is an escaped pipe: it becomes a literal `|` in the cell
      // content (unescaped here, so a code span sees `|` not `\|`)
      if (i + 1 < n && t.charCodeAt(i + 1) === 124) { cur += '|'; i += 2; continue; }
      if (i + 1 < n) { cur += t[i] + t[i + 1]; i += 2; }
      else { cur += t[i]; i++; }
      continue;
    }
    if (c === 124) { cells.push(cur); cur = ''; i++; continue; }
    cur += t[i];
    i++;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(c => c.trim());
}

/**
 * Parse a table delimiter row (e.g. "|:--|--:|"). Returns the alignment
 * array ('left' | 'right' | 'center' | null per column) or null if the row
 * is not a valid delimiter. Every cell must match :?-+:? (after trim).
 */
function parseTableDelimiter(s) {
  const cells = splitTableRow(s);
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell[0] === ':';
    const right = cell[cell.length - 1] === ':';
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return align;
}

/** True if `s` contains a `|` not escaped by a backslash. */
function hasUnescapedPipe(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 124) {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && s.charCodeAt(j) === 92) { bs++; j--; }
      if (bs % 2 === 0) return true;
    }
  }
  return false;
}

/**
 * If lines[i] (header) + lines[i+1] (delimiter) start a GFM table, return
 * {align, head} — the header cells and per-column alignment. The header and
 * delimiter must have the same number of cells and neither line may be
 * indented 4+ (that is an indented code block). A table also needs a `|` in
 * the header or the delimiter — otherwise `Foo\n---` is a setext heading,
 * not a table. Otherwise null.
 */
function tableStart(lines, i, end) {
  if (i + 1 >= end) return null;
  const h = lines[i];
  const d = lines[i + 1];
  if (indentCols(h) >= 4 || indentCols(d) >= 4) return null;
  if (isBlank(h) || isBlank(d)) return null;
  if (!hasUnescapedPipe(h.s) && !hasUnescapedPipe(d.s)) return null;
  const head = splitTableRow(h.s);
  const align = parseTableDelimiter(d.s);
  if (!align || head.length === 0 || head.length !== align.length) return null;
  return { align, head };
}

/** Parse a full table starting at lines[start] (tableStart already true). */
// A line ends a table body only if it is empty or all-spaces. A
// whitespace-only line with EXACTLY ONE tab, as its last character, is a
// body row (empty cells), not a blank separator — while two tabs, or a
// tab followed by a space, end the table. (Probed: `\t` and `  \t` are
// rows; `\t\t`, `\t `, ` \t ` end the table.)
function isTableBlank(s) {
  if (s === '') return true;
  let tabs = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9) tabs++;
    else if (c !== 32) return false;
  }
  if (tabs === 1 && s.charCodeAt(s.length - 1) === 9) return false;
  return true;
}

function parseTable(lines, start, end, refs) {
  const ts = tableStart(lines, start, end);
  const ncols = ts.head.length;
  const body = [];
  let i = start + 2;
  while (i < end) {
    const l = lines[i];
    if (isTableBlank(l.s)) break;
    // a whitespace-only line that isTableBlank says is a row (exactly one
    // trailing tab) cannot start a block — it has no content to be an
    // indented code block, heading, fence, etc.
    if (l.s.trim() !== '' && startsBlock(l, false)) break;
    const cells = splitTableRow(l.s);
    while (cells.length < ncols) cells.push('');
    body.push(cells.slice(0, ncols));
    i++;
  }
  return [{ type: 'table', align: ts.align, head: ts.head, body }, i];
}

function parseBlockList(lines, start, end, refs, top = true, inList = false) {
  const blocks = [];
  let i = start;
  let prevI = -1;
  // whether a blank line was seen since the previous block: recorded on
  // each block as `blankBefore` (list looseness reads it — a blank inside
  // a fenced code block or a nested list never sets it, because those
  // blanks are consumed inside their own block, not between blocks)
  let sawBlank = false;
  function pushBlock(b) { b.blankBefore = sawBlank; sawBlank = false; blocks.push(b); }
  while (i < end) {
    if (i <= prevI) i = prevI + 1; // absolute safeguard: never stall on a line
    if (i >= end) break; // the safeguard must not run past the end
    prevI = i;
    const line = lines[i];
    if (isBlank(line)) { sawBlank = true; i++; continue; }
    const ind = indentCols(line);
    const atx = matchAtx(line);
    if (atx) { pushBlock({ type: 'heading', level: atx.level, text: atx.text }); i++; continue; }
    const fence = matchFence(line);
    if (fence) {
      // content lines lose up to the opening fence's indentation — but
      // only for backtick fences: marked does NOT strip the fence indent
      // for tilde (`~~~`) fences, it keeps the content's full indentation
      const find = fence.ch === '~' ? 0 : indentCols(line);
      const buf = [];
      let j = i + 1;
      let closed = false;
      while (j < end) {
        if (matchFenceClose(lines[j], fence)) { j++; closed = true; break; }
        buf.push(stripFenceIndent(lines[j], find).s);
        j++;
      }
      // a closed fence drops one trailing blank line from its content
      // (the blank immediately before the closing fence is its terminator)
      // — even when that blank is the ONLY content line, leaving the
      // block empty (` ```js\n\n``` ` renders `<code ...></code>`)
      if (closed && buf.length > 0 && buf[buf.length - 1] === '') buf.pop();
      const info = fence.info;
      pushBlock({ type: 'code', lang: info ? info.split(/\s+/)[0] : null, text: buf.length ? buf.join('\n') + '\n' : '' });
      i = j;
      continue;
    }
    const ht = htmlBlockType(line);
    if (ht > 0) {
      const buf = [line.s];
      let j = i + 1;
      let endedAtBlank = false;
      // the opening line itself may already contain the closing marker
      // (e.g. <style>…</style> on one line) — then the block is one line
      const closeRe = ht === 1 ? /<\/(script|pre|style|textarea)[\s>]/i :
        ht === 2 ? /-->/ : ht === 3 ? /\?>/ : ht === 4 ? />/ : ht === 5 ? /\]\]>/ : null;
      const closedOnFirst = closeRe ? closeRe.test(line.s) : false;
      while (!closedOnFirst && j < end) {
        const l = lines[j];
        if (ht === 1) {
          buf.push(l.s); j++;
          if (/<\/(script|pre|style|textarea)[\s>]/i.test(l.s)) break;
        } else if (ht === 2) { buf.push(l.s); j++; if (l.s.indexOf('-->') >= 0) break; }
        else if (ht === 3) { buf.push(l.s); j++; if (l.s.indexOf('?>') >= 0) break; }
        else if (ht === 4) { buf.push(l.s); j++; if (l.s.indexOf('>') >= 0) break; }
        else if (ht === 5) { buf.push(l.s); j++; if (l.s.indexOf(']]>') >= 0) break; }
        else {
          if (isBlank(l)) { endedAtBlank = true; break; }
          buf.push(l.s); j++;
        }
      }
      // a block that ends at a closing marker (types 1-5) may still end
      // right before a blank line — the blank follows the closing line.
      // Only a TRULY EMPTY line suppresses the trailing newline; a
      // whitespace-only line (space/tab) does not
      // (`<!-- a\nb\n-->\n\t\nbar` keeps `-->\n`, `<!-- a\nb\n-->\n\nbar`
      // drops it)
      if (!endedAtBlank && j < end && lines[j].s === '') endedAtBlank = true;
      // trailing newline: present unless the block ends right before a
      // blank line; at end-of-input it depends on the input's final newline
      // — but only at the top level: inside a container the block ends where
      // the container's content ends, with no trailing \n
      let text = buf.join('\n');
      if (!endedAtBlank && (j < end || (top && _endsWithNl))) text += '\n';
      pushBlock({ type: 'html', text });
      i = j;
      continue;
    }
    if (matchThematicBreak(line)) { pushBlock({ type: 'hr' }); i++; continue; }
    if (ind <= 3 && line.s.slice(ind)[0] === '>') {
      const [sub, next] = collectBlockquote(lines, i, end, refs);
      const children = parseBlockList(sub, 0, sub.length, refs, false, inList);
      pushBlock({ type: 'blockquote', children });
      i = next;
      continue;
    }
    const marker = matchListMarker(line);
    if (marker) {
      const [list, next] = parseList(lines, i, end, refs);
      pushBlock(list);
      i = next;
      continue;
    }
    if (ind >= 4) {
      const buf = [];
      let j = i;
      while (j < end) {
        const l = lines[j];
        // a blank line inside indented code keeps its content after the
        // 4-column strip (e.g. 6 spaces -> 2 spaces), it is not empty
        if (isBlank(l)) { buf.push(stripColumns(l, 4).s); j++; continue; }
        if (indentCols(l) >= 4) { buf.push(stripColumns(l, 4).s); j++; continue; }
        break;
      }
      while (buf.length && buf[buf.length - 1] === '') buf.pop();
      pushBlock({ type: 'code', lang: null, text: buf.length ? buf.join('\n') + '\n' : '' });
      i = j;
      continue;
    }
    if (tableStart(lines, i, end)) {
      const [tbl, next] = parseTable(lines, i, end, refs);
      pushBlock(tbl);
      i = next;
      continue;
    }
    const para = parseParagraph(lines, i, end, refs, inList);
    if (para.block) pushBlock(para.block);
    i = para.next;
  }
  return blocks;
}

/* ---------------- rendering ---------------- */

function renderBlocks(blocks, refs, tight) {
  let out = '';
  for (const b of blocks) {
    switch (b.type) {
      case 'para': {
        const html = renderInline(parseInline(b.lines.join('\n'), refs));
        // In a tight list a paragraph renders as bare inline HTML with no
        // trailing newline; elsewhere it is <p>...</p> with a newline.
        out += tight ? html : '<p>' + html + '</p>\n';
        break;
      }
      case 'heading': {
        const html = renderInline(parseInline(b.text, refs));
        out += '<h' + b.level + '>' + html + '</h' + b.level + '>\n';
        break;
      }
      case 'code': {
        const cls = b.lang ? ' class="language-' + escAttr(b.lang) + '"' : '';
        out += '<pre><code' + cls + '>' + esc(b.text) + '</code></pre>\n';
        break;
      }
      case 'html':
        out += b.text;
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let k = 0; k < b.head.length; k++) {
          const a = b.align[k];
          out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInline(b.head[k], refs)) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (b.body.length > 0) {
          out += '<tbody>';
          for (const row of b.body) {
            out += '<tr>\n';
            for (let k = 0; k < b.head.length; k++) {
              const a = b.align[k];
              out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInline(row[k], refs)) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(b.children, refs, false) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const startAttr = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
        out += '<' + tag + startAttr + '>\n';
        for (const item of b.items) {
          let inner = renderBlocks(item.blocks, refs, b.tight);
          if (item.task) {
            const cb = item.task === 'checked'
              ? '<input checked="" disabled="" type="checkbox"> '
              : '<input disabled="" type="checkbox"> ';
            inner = inner.startsWith('<p>') ? '<p>' + cb + inner.slice(3) : cb + inner;
          }
          out += '<li>' + inner + '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/* ---------------- public API ---------------- */

// whether the current input ends with a newline (set by parse; an HTML
// block running to end-of-input keeps a trailing newline only then)
let _endsWithNl = false;

export function parse(src) {
  if (typeof src !== 'string') src = String(src);
  const srcNorm = src.replace(/\r\n?/g, '\n');
  _endsWithNl = srcNorm.endsWith('\n');
  const lines = srcNorm.split('\n').map(s => ({ s, b: 0 }));
  // split() leaves a trailing empty "line" for a final newline; it is not
  // a real line (it would otherwise become content of an unclosed fence)
  if (_endsWithNl && lines.length > 0) lines.pop();
  const refs = new Map();
  const blocks = parseBlockList(lines, 0, lines.length, refs);
  return renderBlocks(blocks, refs, false);
}
