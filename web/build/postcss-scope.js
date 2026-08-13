/* ─────────────────────────────────────────────────────────────────────────────
 * postcss-scope.js — nest every packaged style under one root class.
 *
 * WHY. The console's CSS was written for a page it owned, so it contains things
 * that are correct there and catastrophic in a library:
 *
 *     * { box-sizing: border-box; margin: 0; padding: 0; }
 *     html, body, #root { height: 100%; }
 *     button { cursor: pointer; background: none; border: none; }
 *
 * Shipped as-is, importing this package would strip the margins off a partner's
 * entire site and flatten every button on the page. Equally, their `.sidebar` or
 * `.brand` rules would leak INTO the console.
 *
 * Rather than hand-edit 187 rules — where the failure mode is one missed
 * selector nobody notices until a partner's page breaks — this rewrites them
 * mechanically at build time. Applied ONLY to the library build; our own app
 * keeps the global reset it legitimately wants.
 *
 * The interesting cases are the ones a generic prefixer gets wrong:
 *   :root                 → .ft-root            (custom properties must land on
 *                                                the console root, not the page)
 *   :root[data-theme=x]   → .ft-root[…], :root[…] .ft-root
 *                                               (theme set on the console OR on
 *                                                the host's <html> both work)
 *   html, body, #root     → .ft-root            (prefixing would yield
 *                                                `.ft-root body`, which matches
 *                                                nothing and silently drops it)
 *   *                     → .ft-root, .ft-root *(the root needs the reset too)
 * ─────────────────────────────────────────────────────────────────────────── */

const ROOT_LIKE = new Set(['html', 'body', '#root', ':root', ':host']);

/** Selectors inside these at-rules are keyframe stops, not element selectors. */
const KEYFRAME_AT = /^(-\w+-)?keyframes$/i;

function scopeSelector(sel, root) {
  const s = sel.trim();
  if (!s) return s;

  // Already scoped — idempotent, so running twice cannot double-prefix.
  if (s === root || s.startsWith(`${root} `) || s.startsWith(`${root}.`)
      || s.startsWith(`${root}[`) || s.startsWith(`${root}:`)) {
    return s;
  }

  if (s === '*') return `${root}, ${root} *`;
  if (ROOT_LIKE.has(s)) return root;

  // `:root[data-theme="light"]` and friends: honour the attribute whether the
  // host set it on <html> (a page-wide theme) or the console root (the `theme`
  // prop). Both spellings are emitted.
  const rootAttr = s.match(/^:root(\[[^\]]+\]|\.[\w-]+)(.*)$/);
  if (rootAttr) {
    const [, qualifier, rest] = rootAttr;
    const tail = rest.trim();
    return tail
      ? `${root}${qualifier} ${tail}, :root${qualifier} ${root} ${tail}`
      : `${root}${qualifier}, :root${qualifier} ${root}`;
  }

  // A descendant selector that STARTS at html/body — `body .console` — should
  // anchor at the root, not sit under a body that will never be inside it.
  const leading = s.match(/^(html|body|#root)\s+(.*)$/);
  if (leading) return `${root} ${leading[2]}`;

  return `${root} ${s}`;
}

/**
 * @param {string} root  The scoping class, with its dot. Default '.ft-root'.
 */
export default function postcssScope({ root = '.ft-root' } = {}) {
  return {
    postcssPlugin: 'floodtwin-scope',
    Rule(rule) {
      // Keyframe stops (`from`, `to`, `50%`) are not selectors.
      const parentAt = rule.parent?.type === 'atrule' ? rule.parent.name : '';
      if (KEYFRAME_AT.test(parentAt)) return;

      // `@font-face`/`@property` descriptors have no selector list either.
      if (rule.selector == null) return;

      rule.selectors = [...new Set(
        rule.selectors
          .map((sel) => scopeSelector(sel, root))
          // scopeSelector can return a comma list ("*"), so flatten before
          // postcss re-joins them — otherwise the comma ends up escaped inside
          // a single selector and matches nothing.
          .join(', ')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        // Deduped because several source selectors legitimately collapse to the
        // same target: `html, body, #root` all become `.ft-root`.
      )];
    },
  };
}

postcssScope.postcss = true;
